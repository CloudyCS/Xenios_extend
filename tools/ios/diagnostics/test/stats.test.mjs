// The dashboard's data (../worker/stats.mjs) and page, on local fakes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import worker, {ingest, runCron} from '../worker/index.mjs';
import {stats} from '../worker/stats.mjs';
import {
  INTERVAL_EDGES_MS, compatNames, crashKind, crashSignature, dayOffset, histogramCounts,
  histogramStats, messageKey, pacingOf,
} from '../worker/lib.mjs';
import {fakeD1, allowAll} from '../dev/fakes.mjs';
import {KEY, sign} from './helpers.mjs';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const NOW = new Date('2026-11-03T12:00:00Z');
const TODAY = '2026-11-03';
const COMPAT = [
  {title: 'Halo 3', titleId: '4D5307E6', titleIds: ['4D5307E6'], status: 'playable'},
  {title: 'Gears of War 2', titleId: '4D53082D', titleIds: ['4D53082D', '4D530872'], status: 'playable'},
];

test('histogram columns, pacing, game names and signal names', () => {
  const counts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  assert.deepEqual(histogramCounts({intervalMs: INTERVAL_EDGES_MS, counts}), counts);
  assert.equal(histogramCounts({intervalMs: [1, 2], counts: [1, 2, 3]}), null);
  assert.equal(histogramCounts({intervalMs: INTERVAL_EDGES_MS, counts: counts.slice(1)}), null);
  assert.equal(pacingOf({}), 'capped', 'records from before the field ran capped');
  assert.equal(pacingOf({guestRefreshCap: 'uncapped'}), 'uncapped');
  const names = compatNames(JSON.stringify(COMPAT), ['4D530872', '4D5307E6', 'DEADBEEF']);
  assert.equal(names.has('DEADBEEF'), false);
  assert.equal(names.get('4D530872').name, 'Gears of War 2');
  assert.equal(names.get('4D5307E6').status, 'playable');
  assert.equal(crashKind({signal: 11}), 'SIGSEGV');
  assert.equal(crashKind({signal: 'SIGBUS'}), 'SIGBUS');
  assert.equal(messageKey('Out of memory at 0x1F00 after 12 tries\nmore'), 'Out of memory at 0x# after # tries');
  assert.equal(crashSignature('fatal', [], 'Failed to create the Metal device.'),
               'fatal: Failed to create the Metal device.');
});

const PAYLOAD = 'xenios-build-attestation-v1;platform=ios;channel=release;buildId=ios-release-2.2.0-9901';

function makeEnv() {
  return {DB: fakeD1(':memory:', SCHEMA), LIMITER: allowAll, ATTESTATION_KEY: KEY,
          DASHBOARD_LABEL: 'Test data', DASHBOARD_ACCESS: 'open'};
}

function record(kind, body, {official = true, model = 'iPhone17,1', os = '27.1'} = {}) {
  return {
    schema: 1, kind, id: randomUUID(),
    build: {buildId: official ? 'ios-release-2.2.0-9901' : 'ios-self-built-2-2-9902', channel: 'release',
            ...(official ? {attestation: {payload: PAYLOAD, signature: sign(PAYLOAD)}} : {})},
    device: {model, os}, body,
  };
}

async function post(env, value, day = TODAY) {
  const text = JSON.stringify(value);
  const response = await ingest(new Request('http://localhost/v1/diag', {method: 'POST', body: text,
    headers: {'Content-Type': 'application/json', 'Content-Length': String(text.length)}}),
    env, new Date(`${day}T12:00:00Z`));
  assert.equal(response.status, 204);
}

// 1000 frames: 900 in the 30 fps band, 100 in the 20 fps band.
const THIRTY = [0, 0, 0, 0, 0, 900, 0, 100, 0, 0, 0, 0, 0];
// 1000 frames at 60 fps.
const SIXTY = [0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const L1 = randomUUID();

function session(titleId, extra = {}) {
  return {titleId, durationS: 600, activeS: 600, frames: 1000,
          intervalMs: INTERVAL_EDGES_MS, counts: THIRTY, longFrames: 10, longFramesDuringShaderCompile: 4,
          thermalS: {nominal: 300, fair: 200, serious: 100, critical: 0}, lowPowerS: 0,
          peakFootprintMB: 3000, minAvailableMB: 500, memoryWarnings: 0, firstFrameMs: 6000,
          pipelinesCompiled: 20, storedPipelines: 900, gpuErrors: 0,
          guestRefreshCap: 'capped', framerateLimit: 0, end: 'normal', ...extra};
}

async function seeded() {
  const env = makeEnv();
  // A first run: no stored shaders, a slow start and more hitches.
  await post(env, record('session', session('4D5307E6', {storedPipelines: 0, pipelinesCompiled: 600,
                                                         firstFrameMs: 8000, longFrames: 30})));
  await post(env, record('session', session('4D5307E6', {peakFootprintMB: 4000, end: 'killed',
                                                         firstFrameMs: 4000})));
  // Uncapped play shows in the share and its own histogram, not in the frame
  // rate. A build that doesn't report the shader cache.
  await post(env, record('session', session('4D5307E6', {guestRefreshCap: 'uncapped', counts: SIXTY,
                                                         storedPipelines: undefined, gpuErrors: 2})));
  await post(env, record('session', session('4D53082D', {end: 'crash'}),
                         {model: 'iPad17,3', os: '27.0'}));
  await post(env, record('session', session('4D53082D'), {official: false}));
  await post(env, record('session', session('4D53082D')), dayOffset(TODAY, -10));
  await post(env, record('crash', {source: 'extension', type: 'fault', signal: 11, launchId: L1, faultAddress: '0x0',
    titleId: '4D53082D', frames: [{image: '<jit>', offset: '0x10'},
      {image: 'XeniOS', offset: '0x20', symbol: 'xe::kernel::XThread::Execute()'}]},
    {model: 'iPad17,3', os: '27.0'}));
  await post(env, record('crash', {source: 'app', type: 'fault', signal: 'SIGSEGV', launchId: L1,
    titleId: '4D53082D', frames: [{image: '<jit>', offset: '0x10'}, {image: 'XeniOS', offset: '0x20'}]},
    {model: 'iPad17,3', os: '27.0'}));
  await post(env, record('crash', {source: 'app', type: 'fatal', launchId: randomUUID(), titleId: '4D5307E6',
    message: 'Failed to create the Metal device.', frames: []}));
  const fetches = [];
  const fakeFetch = async (url) => {
    fetches.push(String(url));
    return new Response(JSON.stringify(COMPAT), {headers: {'Content-Type': 'application/json'}});
  };
  await runCron(env, NOW, fakeFetch);
  return {env, fetches, fakeFetch};
}

const view = (env, name, query = '') =>
  stats(name, env, new URL(`http://localhost/v1/stats/${name}?${query}`), NOW);

test('game names come from the compatibility list, fetched only for new title IDs', async () => {
  const {env, fetches, fakeFetch} = await seeded();
  assert.deepEqual(fetches, ['https://xenios.jp/compatibility/search-index.json']);
  const names = env.DB.sqlite.prepare('SELECT * FROM title_names ORDER BY title_id').all();
  assert.deepEqual(names.map((n) => [n.title_id, n.name]),
                   [['4D5307E6', 'Halo 3'], ['4D53082D', 'Gears of War 2']]);
  await runCron(env, NOW, fakeFetch);
  assert.equal(fetches.length, 1, 'known names are not fetched again');
});

test('stats views: overview, games, crashes, devices, builds', async () => {
  const {env} = await seeded();

  const meta = await view(env, 'meta');
  assert.equal(meta.label, 'Test data');
  assert.equal(meta.since, dayOffset(TODAY, -6));
  assert.deepEqual(meta.builds.map((b) => b.build_id), ['ios-release-2.2.0-9901']);
  assert.deepEqual(meta.edges, INTERVAL_EDGES_MS);
  assert.equal(meta.buckets.length, INTERVAL_EDGES_MS.length + 1);

  const overview = await view(env, 'overview');
  assert.equal(overview.current.sessions, 4, 'official, last 7 days');
  assert.equal(overview.current.killed, 1);
  assert.equal(overview.current.crashFreePct, 50);
  assert.equal(overview.current.crashReports, 2, 'the app duplicate of L1 is left out');
  assert.equal(overview.previous.sessions, 1, 'ten days ago is the previous 7 days');
  assert.equal(overview.daily.length, 1);
  assert.equal(overview.topTitles[0].name, 'Halo 3');

  const games = await view(env, 'titles');
  const halo = games.find((g) => g.titleId === '4D5307E6');
  assert.equal(halo.sessions, 3);
  assert.equal(halo.medianFps, histogramStats(THIRTY.map((c) => c * 2)).medianFps, 'capped play only');
  assert.equal(halo.uncappedPct, 33.3);
  assert.equal(halo.compilePct, 24, '12 of 50 long frames');
  assert.equal(halo.firstFrameS, 6);
  assert.equal(halo.gpuErrorPct, 33.3);
  assert.equal(halo.coldPct, 50, 'one of the two sessions that reported the cache');
  assert.deepEqual([halo.hitchesPerMinCold, halo.hitchesPerMinWarm], [3, 1]);
  assert.equal((await view(env, 'titles', 'days=30')).find((g) => g.titleId === '4D53082D').sessions, 2);
  assert.equal((await view(env, 'titles', 'unofficial=1')).find((g) => g.titleId === '4D53082D').sessions, 2);
  assert.deepEqual((await view(env, 'titles', 'device=iPad17')).map((g) => g.titleId), ['4D53082D']);

  const detail = await view(env, 'title', 'title=4d5307e6');
  assert.equal(detail.name, 'Halo 3');
  assert.deepEqual(detail.histogram.capped, THIRTY.map((c) => c * 2));
  assert.deepEqual(detail.histogram.uncapped, SIXTY);
  assert.equal(detail.devices[0].key, 'iPhone17');
  assert.deepEqual(detail.startup.firstFrameS, {p50: 6, p90: 8});
  assert.deepEqual(detail.startup.pipelinesCompiled, {p50: 20, p90: 600});
  assert.deepEqual(detail.memory.peakMB, {p50: 3000, p90: 4000});
  assert.deepEqual(detail.pacing.map((p) => p.key).sort(), ['capped', 'uncapped']);
  assert.equal(await view(env, 'title', 'title=nope'), null);

  const crashes = await view(env, 'crashes');
  const jit = crashes.groups.find((g) => g.signature === 'SIGSEGV: <jit> < xe::kernel::XThread::Execute');
  assert.equal(jit.reports, 1);
  assert.deepEqual(jit.sources, ['extension']);
  assert.equal(jit.topGames[0].name, 'Gears of War 2');
  assert.deepEqual(jit.perDay, {[TODAY]: 1});
  assert.ok(crashes.groups.some((g) => g.signature === 'fatal: Failed to create the Metal device.'));

  const crash = await view(env, 'crash', `signature=${encodeURIComponent(jit.signature)}`);
  assert.equal(crash.latest.source, 'extension');
  assert.equal(crash.latest.faultAddress, '0x0');
  assert.equal(crash.latest.frames[1].symbol, 'xe::kernel::XThread::Execute()');
  assert.equal(crash.breakdowns.games[0].name, 'Gears of War 2');
  assert.equal(crash.firstDay, TODAY);

  const devices = await view(env, 'devices');
  const phone = devices.classes.find((c) => c.key === 'iPhone17');
  assert.equal(phone.sessions, 3);
  assert.deepEqual(phone.thermal, {nominal: 900, fair: 600, serious: 300, critical: 0});
  assert.equal(phone.hotPct, 16.7);
  assert.deepEqual(devices.oses.map((o) => o.key).sort(), ['27.0', '27.1']);

  const builds = await view(env, 'builds', 'unofficial=1');
  assert.deepEqual(builds.map((b) => [b.buildId, b.official]).sort(),
                   [['ios-release-2.2.0-9901', true], ['ios-self-built-2-2-9902', false]]);
  assert.equal(builds.find((b) => b.official).crashReports, 2);
  assert.equal(await view(env, 'nope'), null);
});

test('the dashboard page is self-contained', async () => {
  const response = await worker.fetch(new Request('http://localhost/'), makeEnv());
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const html = await response.text();
  assert.doesNotMatch(html, /(src|href)=["']?https?:/i, 'no external resources');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
});
