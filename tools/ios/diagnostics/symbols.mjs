// A release's symbol map (tools/ios/make_symbol_map.sh) as D1 rows
// (symbol_chunks in schema.sql), so the Worker's cron inflates only the chunks
// a crash needs:
//   node symbols.mjs OUT/symbols/<UUID>.map.gz... > symbols.sql
//   wrangler d1 execute xenios-diagnostics --remote --file symbols.sql
// Rows for a UUID already there are replaced.

import {readFileSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {symbolMapChunks} from './worker/lib.mjs';

// [{uuid, start, data}] for one map, data being the gzip of a chunk.
export function symbolRows(gzBytes) {
  const {uuid, chunks} = symbolMapChunks(gunzipSync(gzBytes).toString('utf8'));
  if (!/^[0-9A-F-]{36}$/.test(uuid ?? '')) throw new Error('the map has no UUID header');
  return chunks.map(({start, text}) => ({uuid, start, data: gzipSync(text, {level: 9})}));
}

// Stores one map in a D1 binding (the local fakes, or a Worker's).
export async function storeSymbolMap(env, gzBytes) {
  const rows = symbolRows(gzBytes);
  await env.DB.batch(rows.map((row) => env.DB.prepare(
      'INSERT OR REPLACE INTO symbol_chunks (uuid, start, data) VALUES (?, ?, ?)')
      .bind(row.uuid, row.start, row.data)));
  return rows.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error('usage: node symbols.mjs MAP.map.gz... > symbols.sql');
    process.exit(2);
  }
  for (const path of paths) {
    const rows = symbolRows(readFileSync(path));
    for (const {uuid, start, data} of rows) {
      console.log(`INSERT OR REPLACE INTO symbol_chunks (uuid, start, data) VALUES ` +
                  `('${uuid}', ${start}, X'${data.toString('hex')}');`);
    }
    console.error(`${path}: ${rows.length} chunks`);
  }
}
