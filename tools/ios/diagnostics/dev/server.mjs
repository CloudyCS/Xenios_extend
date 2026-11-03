// Runs the Worker locally on the fakes, persisted under DATA_DIR:
//   node dev/server.mjs DATA_DIR [PORT]
// POST /v1/diag as in production; POST /__cron runs the scheduled work; the
// dashboard is at /. Listens on 127.0.0.1 only. ATTESTATION_KEY may be set in
// the environment to recognise test-signed builds as official, and
// DASHBOARD_LABEL to badge the dashboard (dev/synthetic.mjs data, say).

import {createServer} from 'node:http';
import worker, {runCron} from '../worker/index.mjs';
import {localEnv, localFetch} from './local.mjs';

const [dataDir, port = '8787'] = process.argv.slice(2);
if (!dataDir) {
  console.error('usage: node dev/server.mjs DATA_DIR [PORT]');
  process.exit(2);
}
const env = localEnv(dataDir);

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let response;
  if (req.method === 'POST' && req.url === '/__cron') {
    await runCron(env, new Date(), localFetch(dataDir));
    response = new Response(null, {status: 204});
  } else {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, String(v));
    headers.set('CF-Connecting-IP', req.socket.remoteAddress ?? 'local');
    response = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body}), env);
  }
  console.log(`${req.method} ${req.url} ${response.status} ${body.length}B`);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(port), '127.0.0.1', () => console.log(`listening on 127.0.0.1:${port}`));
