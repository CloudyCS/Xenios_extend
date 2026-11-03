// The Worker end to end on local fakes (../dev/fakes.mjs): ingest, cron, stats.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import worker, {runCron} from '../worker/index.mjs';
import {verifyAccess, resetAccessKeys} from '../worker/access.mjs';
import {INTERVAL_EDGES_MS} from '../worker/lib.mjs';
import {fakeD1, allowAll} from '../dev/fakes.mjs';
import {storeSymbolMap} from '../symbols.mjs';
import {KEY, sign} from './helpers.mjs';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const UUID = 'C04E6678-6BB2-36C0-BBAB-728B36AF435F';
const NOW = new Date('2026-11-03T12:00:00Z');
const BUILD = 'ios-release-2.2.0-9901';
const PAYLOAD = `xenios-build-attestation-v1;platform=ios;channel=release;buildId=${BUILD}`;
const L1 = randomUUID();
const L2 = randomUUID();
const L3 = randomUUID();

function makeEnv(extra = {}) {
  return {DB: fakeD1(':memory:', SCHEMA), LIMITER: allowAll, ATTESTATION_KEY: KEY,
          DASHBOARD_ACCESS: 'open', ...extra};
}

function record(kind, body, {official = true, model = 'iPhone17,1', buildId = BUILD} = {}) {
  return {
    schema: 1, kind, id: randomUUID(),
    build: {buildId, channel: 'release', binaryUUID: UUID,
            ...(official ? {attestation: {payload: PAYLOAD, signature: sign(PAYLOAD)}} : {})},
    device: {model, os: '27.1'},
    body,
  };
}

async function post(env, value, {gzip = false} = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const body = gzip ? gzipSync(text) : Buffer.from(text);
  const headers = {'Content-Type': 'application/json', 'Content-Length': String(body.length)};
  if (gzip) headers['Content-Encoding'] = 'gzip';
  return worker.fetch(new Request('http://localhost/v1/diag', {method: 'POST', headers, body}), env);
}

async function get(env, path, headers = {}) {
  return worker.fetch(new Request('http://localhost' + path, {headers}), env);
}

const SESSION = {
  titleId: '4D5307E6', durationS: 1800, activeS: 1700, frames: 50000,
  intervalMs: INTERVAL_EDGES_MS,
  counts: [0, 0, 100, 50, 200, 49000, 300, 100, 150, 60, 30, 10, 0], gaps: 2, longFrames: 250,
  longFramesDuringShaderCompile: 60, thermalS: {nominal: 900, fair: 600, serious: 300, critical: 0},
  lowPowerS: 0, peakFootprintMB: 3400, minAvailableMB: 400, memoryWarnings: 1, firstFrameMs: 9200,
  pipelinesCompiled: 340, storedPipelines: 0, gpuErrors: 1, end: 'crash',
};

test('ingest checks, cleans, verifies attestation and stores', async () => {
  const env = makeEnv();
  assert.equal((await post(env, record('session', SESSION), {gzip: true})).status, 204);
  assert.equal((await post(env, record('session', {...SESSION, end: 'normal', durationS: 6e18},
                                       {official: false}))).status, 204);
  // An attestation copied from another build doesn't make this one official.
  assert.equal((await post(env, record('session', SESSION, {buildId: 'ios-self-built-9902'}))).status, 204);
  assert.equal((await post(env, '{nope')).status, 400);
  assert.equal((await post(env, record('logfile', {}))).status, 400);
  assert.equal((await get(env, '/v1/diag')).status, 405);

  const rows = env.DB.sqlite.prepare('SELECT * FROM sessions ORDER BY official DESC, build_id').all();
  assert.deepEqual(rows.map((r) => [r.build_id, r.official]),
                   [[BUILD, 1], [BUILD, 0], ['ios-self-built-9902', 0]]);
  assert.equal(rows[0].end_reason, 'crash');
  assert.equal(rows[0].device_class, 'iPhone17');
  assert.equal(rows[0].median_fps, 30);
  assert.deepEqual([rows[0].first_frame_ms, rows[0].pipelines_compiled, rows[0].stored_pipelines,
                    rows[0].gpu_errors], [9200, 340, 0, 1]);
  assert.equal(rows[1].duration_s, null, 'an impossible duration is dropped');
  const raw = env.DB.sqlite.prepare('SELECT * FROM raw ORDER BY rowid').all();
  assert.equal(raw.length, 3);
  assert.equal(raw[0].kind, 'session');
  const stored = JSON.parse(raw[0].record);
  assert.equal(stored.build.attestation, undefined, 'attestation is not kept');
  assert.equal(typeof stored.build.official, 'boolean');
  assert.equal(stored.receivedDay, new Date().toISOString().slice(0, 10));
  assert.equal(stored.id, stored.id.toUpperCase());
});

test('the client IP address is used for the rate limit and never stored', async () => {
  const keys = [];
  const env = makeEnv({LIMITER: {limit: async ({key}) => { keys.push(key); return {success: true}; }}});
  const text = JSON.stringify(record('session', SESSION));
  const response = await worker.fetch(new Request('http://localhost/v1/diag', {method: 'POST',
    body: text, headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7'}}), env);
  assert.equal(response.status, 204);
  assert.deepEqual(keys, ['203.0.113.7']);
  const rows = JSON.stringify(env.DB.sqlite.prepare('SELECT * FROM sessions').all());
  const raw = JSON.stringify(env.DB.sqlite.prepare('SELECT * FROM raw').all());
  assert.doesNotMatch(rows + raw, /203\.0\.113\.7/);
});

test('ingest caps sizes before and after inflating', async () => {
  const env = makeEnv();
  const big = record('session', {...SESSION, note: 'x'.repeat(300 * 1024)});
  assert.equal((await post(env, big)).status, 413, 'Content-Length over the cap');
  assert.equal((await post(env, big, {gzip: true})).status, 413, 'inflates past the cap');
  // No Content-Length: the stream itself is capped.
  const bytes = Buffer.from(JSON.stringify(big));
  const stream = new ReadableStream({start(c) { c.enqueue(bytes); c.close(); }});
  const response = await worker.fetch(new Request('http://localhost/v1/diag', {
    method: 'POST', body: stream, duplex: 'half', headers: {'Content-Type': 'application/json'}}), env);
  assert.equal(response.status, 413);
  const corrupt = await worker.fetch(new Request('http://localhost/v1/diag', {
    method: 'POST', body: Buffer.from('not gzip'), headers: {'Content-Encoding': 'gzip'}}), env);
  assert.equal(corrupt.status, 400);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('cron symbolicates, dedupes one launch, groups, drafts issues and rolls up', async () => {
  const env = makeEnv();
  const map = '#uuid=' + UUID + ' textvmaddr=0x100000000\n' +
      '100000000 _mh_execute_header\n100001000 xe::kernel::XThread::Execute()\n' +
      '100002000 xe::cpu::Processor::Execute(xe::cpu::ThreadState*, unsigned int)\n';
  await storeSymbolMap(env, gzipSync(map));

  // One launch, reported by the app at the next launch, by the extension and
  // by MetricKit.
  const app = record('crash', {source: 'app', type: 'fault', launchId: L1, titleId: '4D5307E6',
    signal: 'SIGSEGV', binaryUUID: UUID, frames: [
      {image: '<jit>', offset: '0x40'}, {image: 'XeniOS', offset: '0x2010'},
      {image: 'XeniOS', offset: '0x1008'}, {image: 'system'}]});
  const extension = record('crash', {source: 'extension', type: 'fault', launchId: L1,
    titleId: '4D5307E6', signal: 11, faultAddress: '0x18', frames: [
      {image: '<jit>', offset: '0x40'},
      {image: 'XeniOS', offset: '0x2010', symbol: 'xe::cpu::Processor::Execute(xe::cpu::ThreadState*, unsigned int)'},
      {image: 'XeniOS', offset: '0x1008', symbol: 'xe::kernel::XThread::Execute()'}]});
  const metrickit = record('crash', {source: 'metrickit', launchId: L1, titleId: '4D5307E6',
    signal: 11, exceptionType: 1, frames: [
      {image: 'XeniOS', offset: '0x1010', binaryUUID: UUID}, {image: 'UIKitCore', offset: '0x99'}]});
  const fatal = record('crash', {source: 'app', type: 'fatal', launchId: L2,
    message: 'Unable to open ~/Documents/My Games/halo.iso', frames: []});
  const watchdog = record('crash', {source: 'metrickit', launchId: L3, signal: 9,
    terminationReason: 'Namespace FRONTBOARD, Code 0x8badf00d', frames: [
      {image: 'libsystem_kernel.dylib', offset: '0x10'}]});
  for (const r of [app, metrickit, extension, fatal, watchdog, record('session', SESSION)]) {
    assert.equal((await post(env, r)).status, 204);
  }

  await runCron(env, NOW);
  const crashes = Object.fromEntries(env.DB.sqlite.prepare('SELECT * FROM crashes').all()
      .map((c) => [c.id, c]));
  const signed = (r) => crashes[r.id.toUpperCase()];
  assert.equal(signed(app).signature,
               'SIGSEGV: <jit> < xe::cpu::Processor::Execute < xe::kernel::XThread::Execute');
  assert.equal(signed(extension).signature, signed(app).signature,
               'signal 11 from the extension signs like SIGSEGV from the app');
  assert.equal(signed(extension).duplicate_of, null, 'the extension report wins');
  assert.equal(signed(app).duplicate_of, extension.id.toUpperCase());
  assert.equal(signed(metrickit).duplicate_of, extension.id.toUpperCase());
  assert.equal(signed(metrickit).signature, '[metrickit] SIGSEGV: xe::kernel::XThread::Execute');
  assert.equal(signed(extension).fault_address, '0x18');
  assert.equal(signed(fatal).signature, 'fatal: Unable to open ~/Documents/<file>');
  assert.equal(signed(watchdog).signature, '[metrickit] SIGKILL: Namespace FRONTBOARD, Code 0x8badf00d');

  const groups = env.DB.sqlite.prepare('SELECT * FROM crash_groups ORDER BY signature').all();
  const bySig = Object.fromEntries(groups.map((g) => [g.signature, g]));
  assert.equal(bySig[signed(extension).signature].count, 1, 'the duplicates are not counted');
  assert.equal(bySig[signed(metrickit).signature]?.count ?? 0, 0);
  assert.equal(bySig[signed(extension).signature].dirty, 1, 'one report: no issue yet');

  const daily = env.DB.sqlite.prepare('SELECT * FROM daily_title').all();
  assert.equal(daily.length, 1);
  assert.deepEqual([daily[0].unclean, daily[0].gpu_error_sessions, daily[0].cold_sessions,
                    daily[0].cache_known_sessions], [1, 1, 1, 1]);

  const stats = await (await get(env, '/v1/stats/crashes?days=7')).json();
  assert.equal(stats.groups.length, 3);
  assert.equal(stats.groups.find((s) => s.signature === signed(app).signature).reports, 1);
  const builds = await (await get(env, '/v1/stats/builds')).json();
  assert.equal(builds[0].crashFreePct, 0);
  assert.equal((await get(env, '/')).headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal((await get(env, '/v1/stats/nope')).status, 404);
});

test('a report without XeniOS frames never outranks one with them', async () => {
  const env = makeEnv();
  const map = '#uuid=' + UUID + ' textvmaddr=0x100000000\n' +
      '100000000 _mh_execute_header\n' +
      '100001000 xe::Emulator::ExceptionCallbackThunk(xe::Exception*, void*)\n10004d000 main\n';
  await storeSymbolMap(env, gzipSync(map));
  // A crash outside a game, as on the iPad: Xenia's handler recorded nothing, so the
  // extension found no crashed thread and MetricKit has the stack. Signed in both orders.
  const STACK = '[metrickit] SIGSEGV: xe::Emulator::ExceptionCallbackThunk < main';
  const launches = [];
  for (const [launchId, extensionFirst] of [[L1, true], [L2, false]]) {
    const extension = record('crash', {source: 'extension', type: 'exception', launchId,
      exceptionType: 1, exceptionCodes: ['0xa', '0x20000000b'], frames: []});
    const metrickit = record('crash', {source: 'metrickit', type: 'exception', launchId,
      signal: 11, exceptionType: 1, frames: [
        {image: 'XeniOS', offset: '0x1010', binaryUUID: UUID},
        {image: 'XeniOS', offset: '0x4d618', binaryUUID: UUID}]});
    for (const r of extensionFirst ? [extension, metrickit] : [metrickit, extension]) {
      assert.equal((await post(env, r)).status, 204);
      await runCron(env, NOW);
    }
    launches.push([extension, metrickit]);
  }

  const crashes = Object.fromEntries(env.DB.sqlite.prepare('SELECT * FROM crashes').all()
      .map((c) => [c.id, c]));
  for (const [extension, metrickit] of launches) {
    const frameless = crashes[extension.id.toUpperCase()];
    const withFrames = crashes[metrickit.id.toUpperCase()];
    assert.equal(frameless.signature, 'exception 1: <no XeniOS frames>');
    assert.equal(withFrames.signature, STACK);
    assert.equal(withFrames.duplicate_of, null, 'the report with frames wins');
    assert.equal(frameless.duplicate_of, withFrames.id);
  }
  const counted = env.DB.sqlite.prepare('SELECT signature, count FROM crash_groups WHERE count > 0')
      .all().map((g) => [g.signature, g.count]);
  assert.deepEqual(counted, [[STACK, 2]]);
});

test('a crash that fails to sign is set aside and the cron carries on', async () => {
  const env = makeEnv();
  env.DB.sqlite.prepare(
      `INSERT INTO crashes (id, day, build_id, official, model, device_class, source, kind, frames)
       VALUES ('poison', '2026-11-01', ?, 1, 'iPhone17,1', 'iPhone17', 'app', 'SIGSEGV', '{oops')`)
      .run(BUILD);
  await post(env, record('crash', {source: 'app', type: 'fatal', launchId: L2,
                                   message: 'Failed to create the Metal device.', frames: []}));
  await post(env, record('session', SESSION));
  await runCron(env, NOW);
  const rows = env.DB.sqlite.prepare('SELECT id, signature FROM crashes ORDER BY day').all();
  assert.deepEqual(rows.map((r) => r.signature),
                   ['<unsigned>', 'fatal: Failed to create the Metal device.']);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_title').get().n, 1,
               'the roll-up still ran');
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM crash_groups WHERE signature = '<unsigned>'")
      .get().n, 0);
});

// The Workers Free plan: 50 subrequests (D1 queries, a batch counting once,
// and fetches) per invocation.
function counting(env) {
  const counts = {requests: 0};
  const db = env.DB;
  const wrap = (statement) => ({
    bind: (...args) => wrap(statement.bind(...args)),
    run: () => { ++counts.requests; return statement.run(); },
    all: () => { ++counts.requests; return statement.all(); },
    first: () => { ++counts.requests; return statement.first(); },
    statement,
  });
  return {counts, env: {...env, DB: {
    sqlite: db.sqlite, prepare: (sql) => wrap(db.prepare(sql)),
    batch: (statements) => { ++counts.requests; return db.batch(statements.map((s) => s.statement ?? s)); },
  }}};
}

test('the cron stays inside the Free plan and works off a backlog over runs', async () => {
  const base = makeEnv();
  const lines = ['#uuid=' + UUID + ' textvmaddr=0x100000000'];
  for (let i = 0; i < 2000; ++i) lines.push(`${(0x100004000 + i * 0x100).toString(16)} xe::f${i}()`);
  await storeSymbolMap(base, gzipSync(lines.join('\n')));
  assert.equal(base.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM symbol_chunks').get().n, 4);
  for (let i = 0; i < 40; ++i) {
    await post(base, record('crash', {source: 'app', type: 'fault', launchId: randomUUID(),
      titleId: '4D5307E6', signal: 'SIGSEGV', binaryUUID: UUID, frames: [
        {image: 'XeniOS', offset: `0x${(0x4000 + (i % 4) * 500 * 0x100 + 0x10).toString(16)}`},
        {image: 'XeniOS', offset: `0x${(0x4000 + 1999 * 0x100 + 0x80).toString(16)}`}]}));
    await post(base, record('session', SESSION));
  }
  const fetches = [];
  const fakeFetch = async (url) => {
    fetches.push(url);
    return new Response('[{"slug":"halo-3","title":"Halo 3","titleId":"4D5307E6","titleIds":["4D5307E6"],"status":"playable"}]');
  };
  const unsigned = () => base.DB.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM crashes WHERE signature IS NULL').get().n;
  const runs = [];
  while (unsigned() > 0 && runs.length < 10) {
    const {counts, env} = counting(base);
    await runCron(env, NOW, async (url) => { ++counts.requests; return fakeFetch(url); });
    runs.push({requests: counts.requests, left: unsigned()});
  }
  console.log('cron runs (subrequests, unsigned left):', runs.map((r) => `${r.requests}/${r.left}`).join(' '));
  assert.ok(runs.every((r) => r.requests <= 45), JSON.stringify(runs));
  assert.ok(runs.length > 1, 'a backlog takes more than one run');
  assert.equal(unsigned(), 0, JSON.stringify(runs));
  assert.equal(fetches.length, 1, 'game names fetched once');
  const signatures = base.DB.sqlite.prepare('SELECT DISTINCT signature FROM crashes ORDER BY 1').all()
      .map((r) => r.signature);
  assert.deepEqual(signatures, [0, 500, 1000, 1500].map((n) => `SIGSEGV: xe::f${n} < xe::f1999`).sort());
  assert.equal(base.DB.sqlite.prepare("SELECT name FROM title_names WHERE title_id = '4D5307E6'")
      .get().name, 'Halo 3');
});

test('triage issues go to GitHub only with a token, rationed', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({url, init});
    return new Response(JSON.stringify({number: 100 + calls.length}), {status: 201});
  };
  const env = makeEnv({GITHUB_TOKEN: 'placeholder', GITHUB_REPO: 'example/crashes'});
  const devices = ['Metal', 'audio', 'input', 'network', 'storage', 'camera', 'display'];
  for (const name of devices) {
    for (let i = 0; i < 2; ++i) {
      await post(env, record('crash', {source: 'app', type: 'fatal', launchId: randomUUID(),
                                       message: `Failed to create the ${name} device.`, frames: []}));
    }
  }
  await post(env, record('crash', {source: 'app', type: 'fatal', launchId: randomUUID(),
                                   message: 'Seen only once.', frames: []}));
  await post(env, record('crash', {source: 'app', type: 'fatal', launchId: randomUUID(),
                                   message: 'Self-built only.', frames: []}, {official: false}));
  await post(env, record('crash', {source: 'app', type: 'fatal', launchId: randomUUID(),
                                   message: 'Self-built only.', frames: []}, {official: false}));
  await runCron(env, NOW, fakeFetch, Infinity);
  assert.equal(calls.length, 5, 'at most five new issues a run');
  assert.equal(calls[0].url, 'https://api.github.com/repos/example/crashes/issues');
  assert.equal(calls[0].init.method, 'POST');
  assert.doesNotMatch(calls[0].init.body, /placeholder/);
  await runCron(env, NOW, fakeFetch, Infinity);
  assert.equal(calls.length, 7, 'the rest the next run');
  const groups = env.DB.sqlite.prepare('SELECT * FROM crash_groups ORDER BY signature').all();
  const once = groups.find((g) => g.signature === 'fatal: Seen only once.');
  assert.equal(once.issue_number, null, 'one report is not an issue');
  assert.equal(groups.some((g) => g.signature === 'fatal: Self-built only.'), false,
               'self-built builds are not counted');
  // A new report updates the existing issue.
  await post(env, record('crash', {source: 'app', type: 'fatal', launchId: randomUUID(),
                                   message: 'Failed to create the Metal device.', frames: []}));
  await runCron(env, NOW, fakeFetch, Infinity);
  assert.equal(calls.length, 8);
  assert.equal(calls[7].init.method, 'PATCH');
  assert.match(JSON.parse(calls[7].init.body).body, /\*\*3\*\* reports/);
});

test('raw data older than 90 days is deleted, aggregates kept', async () => {
  const env = makeEnv();
  await post(env, record('session', SESSION));
  const old = '2026-07-01';
  env.DB.sqlite.prepare(
      `INSERT INTO sessions (id, day, build_id, official, model, device_class, pacing, title_id)
       VALUES ('old', ?, 'b', 1, 'iPhone17,1', 'iPhone17', 'capped', 'AAAAAAAA')`).run(old);
  env.DB.sqlite.prepare(
      "INSERT INTO daily_title (day, build_id, official, title_id, device_class, pacing, sessions, " +
      "unclean, killed, play_s, hot_s, long_frames, long_frames_compiling, gpu_error_sessions, " +
      "cold_sessions, cache_known_sessions) " +
      "VALUES (?, 'b', 1, '', 'iPhone17', 'capped', 1, 0, 0, 60, 0, 0, 0, 0, 0, 0)").run(old);
  env.DB.sqlite.prepare(`INSERT INTO title_names (title_id, name, status, checked_day) VALUES
      ('AAAAAAAA', NULL, NULL, ?), ('BBBBBBBB', 'Kept', 'playable', ?)`).run(old, old);
  env.DB.sqlite.prepare("INSERT INTO raw (id, day, kind, record) VALUES ('old', ?, 'session', '{}')")
      .run(old);
  await runCron(env, NOW, async () => new Response('offline', {status: 503}));
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'old'").get().n, 0);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM raw WHERE id = 'old'").get().n, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_title WHERE day = ?').get(old).n, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM raw').get().n, 1);
  assert.deepEqual(env.DB.sqlite.prepare('SELECT title_id FROM title_names ORDER BY title_id').all()
      .map((r) => r.title_id), ['BBBBBBBB'], 'an unknown title ID no record names is forgotten');
});

// ---- Cloudflare Access

const TEAM = 'https://example.cloudflareaccess.com';
const AUD = 'test-audience-tag';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function accessKeys() {
  const pair = await crypto.subtle.generateKey(
      {name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
       hash: 'SHA-256'}, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  let fetches = 0;
  const fetchImpl = async (url) => {
    ++fetches;
    assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({keys: [{...jwk, kid: 'k1'}]}));
  };
  async function token(claims = {}, header = {}) {
    const seconds = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({alg: 'RS256', kid: 'k1', typ: 'JWT', ...header}));
    const body = b64url(JSON.stringify({aud: [AUD], iss: TEAM, iat: seconds, exp: seconds + 3600,
                                        email: 'maintainer@example.com', ...claims}));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
                                               new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
  }
  return {fetchImpl, token, fetches: () => fetches};
}

const accessRequest = (jwt) => new Request('http://localhost/', {
  headers: jwt ? {'Cf-Access-Jwt-Assertion': jwt} : {}});

test('Access tokens are checked: signature, audience, issuer, time', async () => {
  resetAccessKeys();
  const {fetchImpl, token, fetches} = await accessKeys();
  const env = {ACCESS_TEAM_DOMAIN: TEAM + '/', ACCESS_AUD: AUD};
  const check = async (jwt, e = env) => verifyAccess(accessRequest(jwt), e, fetchImpl);
  const seconds = Math.floor(Date.now() / 1000);

  assert.equal(await check(await token()), true);
  assert.equal(await check(await token({aud: 'other'})), false, 'another application');
  assert.equal(await check(await token({iss: 'https://evil.cloudflareaccess.com'})), false);
  assert.equal(await check(await token({exp: seconds - 120})), false, 'expired');
  assert.equal(await check(await token({exp: seconds - 30})), true, 'within the clock skew');
  assert.equal(await check(await token({nbf: seconds + 600})), false, 'not yet valid');
  assert.equal(await check(await token({}, {alg: 'none'})), false);
  const [h, , s] = (await token()).split('.');
  const forged = b64url(JSON.stringify({aud: [AUD], iss: TEAM, exp: seconds + 3600, email: 'x'}));
  assert.equal(await check(`${h}.${forged}.${s}`), false, 'a changed payload');
  assert.equal(await check(null), false);
  assert.equal(await check('a.b'), false);
  assert.equal(await check(await token(), {ACCESS_TEAM_DOMAIN: TEAM}), false, 'no audience set');
  assert.equal(fetches(), 1, 'keys are cached');
  assert.equal(await check(await token({}, {kid: 'unknown'})), false);
  assert.equal(fetches(), 1, 'an unknown key ID refetches at most once a minute');
});

test('the dashboard and stats need Access; ingest does not', async () => {
  resetAccessKeys();
  const {fetchImpl, token} = await accessKeys();
  const env = makeEnv({DASHBOARD_ACCESS: undefined, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD});
  // Warm the key cache with the fake certs, as the route fetches them itself.
  assert.equal(await verifyAccess(accessRequest(await token()), env, fetchImpl), true);
  assert.equal((await get(env, '/')).status, 403);
  assert.equal((await get(env, '/v1/stats/overview')).status, 403);
  const jwt = {'Cf-Access-Jwt-Assertion': await token()};
  assert.equal((await get(env, '/', jwt)).status, 200);
  assert.equal((await get(env, '/v1/stats/meta', jwt)).status, 200);
  assert.equal((await post(env, record('session', SESSION))).status, 204);
  const unset = makeEnv({DASHBOARD_ACCESS: undefined});
  assert.equal((await get(unset, '/', jwt)).status, 403, 'no Access configured: closed');
});
