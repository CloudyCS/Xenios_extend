// Rebuilds DATA_DIR/d1.sqlite from its raw copies (after a schema change,
// say), then runs the cron and rolls up every day:
//   node dev/rebuild.mjs DATA_DIR
// The same as re-applying schema.sql to D1 and replaying the raw table in
// production: each record goes through today's allowlists, and kinds no
// longer kept are skipped. A DATA_DIR from before the raw table (records and
// symbol maps under r2/) is read from there once.

import {DatabaseSync} from 'node:sqlite';
import {existsSync, readFileSync, readdirSync, renameSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {rollUpDay, store} from '../worker/index.mjs';
import {cleanEnvelope} from '../worker/lib.mjs';
import {storeSymbolMap} from '../symbols.mjs';
import {localEnv, runCronUntilSigned} from './local.mjs';

const [dataDir] = process.argv.slice(2);
const dbPath = dataDir && join(dataDir, 'd1.sqlite');
const r2 = dataDir && join(dataDir, 'r2');
if (!dataDir || !(existsSync(dbPath) || existsSync(r2))) {
  console.error('usage: node dev/rebuild.mjs DATA_DIR (with DATA_DIR/d1.sqlite)');
  process.exit(2);
}

// The raw copies and symbol chunks of the old database, or of r2/.
const raw = [];
const chunks = [];
const maps = [];
if (existsSync(r2)) {
  const rawDir = join(r2, 'raw');
  for (const day of existsSync(rawDir) ? readdirSync(rawDir).sort() : []) {
    for (const kind of readdirSync(join(rawDir, day))) {
      for (const file of readdirSync(join(rawDir, day, kind))) {
        raw.push({day, record: readFileSync(join(rawDir, day, kind, file), 'utf8')});
      }
    }
  }
  const symbolDir = join(r2, 'symbols');
  for (const file of existsSync(symbolDir) ? readdirSync(symbolDir) : []) {
    maps.push(readFileSync(join(symbolDir, file)));
  }
} else {
  const old = new DatabaseSync(dbPath, {readOnly: true});
  raw.push(...old.prepare('SELECT day, record FROM raw ORDER BY day').all());
  chunks.push(...old.prepare('SELECT uuid, start, data FROM symbol_chunks').all());
  old.close();
}

rmSync(dbPath, {force: true});
const env = localEnv(dataDir);
for (const map of maps) await storeSymbolMap(env, map);
if (chunks.length) {
  await env.DB.batch(chunks.map((c) => env.DB.prepare(
      'INSERT INTO symbol_chunks (uuid, start, data) VALUES (?, ?, ?)').bind(c.uuid, c.start, c.data)));
}
const days = new Set();
let records = 0;
let skipped = 0;
for (const {day, record} of raw) {
  const stored = JSON.parse(record);
  const clean = cleanEnvelope(stored);
  if (clean.error) {
    ++skipped;
    continue;
  }
  clean.build.official = stored.build?.official === true;
  clean.receivedDay = stored.receivedDay ?? day;
  await store(env, clean, clean.receivedDay);
  days.add(clean.receivedDay);
  ++records;
}
await runCronUntilSigned(env, dataDir);
for (const day of days) await rollUpDay(env, day);
if (existsSync(r2)) renameSync(r2, join(dataDir, 'r2.migrated'));
console.log(`${records} records over ${days.size} days, ${skipped} skipped`);
