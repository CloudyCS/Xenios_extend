// Checks a deployed diagnostics Worker over HTTP:
//   node dev/live.mjs https://<host> OUT_DIR [ATTESTATION_KEY_FILE]
// Sends attested, self-built and forged records, records with fields the
// Worker must drop, and records it must turn away (size, encoding, JSON,
// schema), checks the dashboard is closed, and ends by tripping the per-IP rate
// limit. Writes OUT_DIR/live-run.json (the build IDs and record IDs it stored,
// to check in D1 and delete afterwards) and OUT_DIR/live-symbols.sql (a small
// symbol map for its crashes, to load before the cron runs).

import {createHmac, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {INTERVAL_EDGES_MS} from '../worker/lib.mjs';
import {symbolRows} from '../symbols.mjs';

const [host, outDir, keyFile] = process.argv.slice(2);
if (!host || !outDir) {
  console.error('usage: node dev/live.mjs https://<host> OUT_DIR [ATTESTATION_KEY_FILE]');
  process.exit(2);
}
mkdirSync(outDir, {recursive: true});
const endpoint = new URL('/v1/diag', host).href;
const key = keyFile ? readFileSync(keyFile, 'utf8').replace(/[\r\n]/g, '') : null;
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const builds = {official: `ios-live-check-${stamp}-1`, self: `ios-live-check-${stamp}-2`,
                forged: `ios-live-check-${stamp}-3`};
const uuid = randomUUID().toUpperCase();
const stored = [];
const results = [];

function check(name, ok, detail = '') {
  results.push({name, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function sign(payload) {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function record(kind, body, buildId, {attest = null, extra = {}} = {}) {
  const payload = `xenios-build-attestation-v1;platform=ios;channel=release;buildId=${attest ?? buildId}`;
  return {
    schema: 1, kind, id: randomUUID(),
    build: {buildId, version: '0.0.0', build: '1', channel: 'release', commit: 'livecheck',
            binaryUUID: uuid,
            ...(key ? {attestation: {payload, signature: sign(payload)}} : {})},
    device: {model: 'iPad16,6', os: '26.1'},
    body, ...extra,
  };
}

async function post(body, headers = {}) {
  const response = await fetch(endpoint, {method: 'POST', body, headers: {
    'Content-Type': 'application/json', ...headers}, duplex: 'half'});
  return response.status;
}

async function send(name, value, want = 204, {gzip = true} = {}) {
  const text = JSON.stringify(value);
  const status = await post(gzip ? gzipSync(text) : text, gzip ? {'Content-Encoding': 'gzip'} : {});
  check(name, status === want, `HTTP ${status}`);
  if (status === 204) stored.push({id: value.id.toUpperCase(), kind: value.kind, build: value.build.buildId});
}

const SESSION = {
  titleId: '4D5307E6', durationS: 600, activeS: 580, frames: 34000, intervalMs: INTERVAL_EDGES_MS,
  counts: [0, 0, 20, 10, 40, 300, 60, 20, 33000, 30, 10, 5, 0], longFrames: 40,
  longFramesDuringShaderCompile: 12, thermalS: {nominal: 500, fair: 100, serious: 0, critical: 0},
  lowPowerS: 0, peakFootprintMB: 2900, minAvailableMB: 900, memoryWarnings: 0, firstFrameMs: 7400,
  pipelinesCompiled: 120, storedPipelines: 900, gpuErrors: 0, end: 'normal',
};

// ---- Closed routes

for (const path of ['/', '/v1/stats/overview']) {
  const status = (await fetch(new URL(path, host))).status;
  check(`GET ${path} without Access`, status === 403, `HTTP ${status}`);
}
check('GET /v1/diag', (await fetch(endpoint)).status === 405);

// ---- Accepted, and what is kept

await send('attested session (gzip)', record('session', SESSION, builds.official));
await send('self-built session, no gzip', {...record('session', SESSION, builds.self), build: {
  buildId: builds.self, channel: 'self-built', binaryUUID: uuid}}, 204, {gzip: false});
await send('forged attestation (signed for another build)',
           record('session', SESSION, builds.forged, {attest: builds.official}));
await send('session with fields the Worker must drop', record('session', {
  ...SESSION, userName: 'Will', email: 'player@example.com', path: '/var/mobile/Containers/x',
  thermalS: {...SESSION.thermalS, location: 'Tokyo'}}, builds.official, {extra: {
    deviceId: 'ABCDEF', ip: '198.51.100.9'}}));
const frames = [{image: '<jit>', offset: '0x40'}, {image: 'XeniOS', offset: '0x4010'},
                {image: 'XeniOS', offset: '0x8020'}, {image: 'system'}];
await send('crash with a path, a file name and an e-mail address in its message', record('crash', {
  source: 'app', type: 'fatal', launchId: randomUUID(), titleId: '4D5307E6', binaryUUID: uuid,
  message: 'Failed to open /var/mobile/Containers/Data/Application/1234/Documents/Halo 3.iso ' +
           'for player@example.com', frames}, builds.official));
await send('crash from a signal', record('crash', {
  source: 'app', type: 'fault', launchId: randomUUID(), titleId: '4D5307E6', binaryUUID: uuid,
  signal: 'SIGSEGV', faultAddress: '0x18', frames}, builds.official));

// ---- Turned away

const big = JSON.stringify(record('session', {...SESSION, note: 'x'.repeat(300 * 1024)}, builds.self));
let status = await post(Buffer.from(big));
check('300 KB body', status === 413, `HTTP ${status}`);
status = await post(gzipSync(big), {'Content-Encoding': 'gzip'});
check(`gzip that inflates past 256 KB (${gzipSync(big).length} bytes sent)`, status === 413, `HTTP ${status}`);
status = await post(new ReadableStream({start(c) { c.enqueue(Buffer.from(big)); c.close(); }}));
check('300 KB streamed without Content-Length', status === 413, `HTTP ${status}`);
status = await post('not gzip', {'Content-Encoding': 'gzip'});
check('gzip header on plain text', status === 400, `HTTP ${status}`);
status = await post('{"schema": 1, "kind": ');
check('broken JSON', status === 400, `HTTP ${status}`);
status = await post(JSON.stringify({...record('session', SESSION, builds.self), kind: 'pictures'}));
check('unknown kind', status === 400, `HTTP ${status}`);
status = await post(JSON.stringify({...record('session', SESSION, builds.self), schema: 99}));
check('unknown schema', status === 400, `HTTP ${status}`);

// ---- Rate limit (30 a minute per IP): last, it locks this IP out for a minute

const statuses = [];
for (let i = 0; i < 40; ++i) statuses.push(await post('{'));
const limited = statuses.filter((s) => s === 429).length;
check('rate limit after 30 a minute', limited > 0, `${limited} of 40 answered 429`);

writeFileSync(join(outDir, 'live-run.json'), JSON.stringify({endpoint, builds, uuid, stored}, null, 2));
const map = ['#uuid=' + uuid + ' textvmaddr=0x100000000', '100000000 _mh_execute_header',
             '100004000 xe::kernel::XThread::Execute()',
             '100008000 xe::cpu::Processor::Execute(xe::cpu::ThreadState*, unsigned int)'].join('\n');
writeFileSync(join(outDir, 'live-symbols.sql'), symbolRows(gzipSync(map)).map(({uuid, start, data}) =>
    `INSERT OR REPLACE INTO symbol_chunks (uuid, start, data) VALUES ('${uuid}', ${start}, X'${data.toString('hex')}');`)
    .join('\n') + '\n');
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed; ${stored.length} records stored`);
process.exit(failed ? 1 : 0);
