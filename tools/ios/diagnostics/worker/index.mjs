// XeniOS diagnostics Worker.
//
//   POST /v1/diag         one record from the app (public; gzip optional)
//   GET  /v1/stats/<view> dashboard data (stats.mjs)
//   GET  /                the dashboard page (dashboard.mjs)
//   cron                  roll up per title, look up game names, delete raw
//                         data after 90 days, symbolicate and group crashes,
//                         sync triage issues
//
// Bindings (wrangler.toml.example): DB (D1, ../schema.sql: the records, the
// raw copies and the symbol maps), LIMITER (rate limiting). Everything fits the
// Workers Free plan, which stops at its limits instead of billing: no R2, and
// at most 50 subrequests (D1 queries and fetches) and 10 ms of CPU an
// invocation.
// Secrets: ATTESTATION_KEY (the release script's HMAC key); optional
// GITHUB_TOKEN with GITHUB_REPO for triage issues. The app carries no secret:
// official builds are recognised by their attestation, and abuse is bounded by
// size caps, per-field allowlists (lib.mjs cleanEnvelope) and per-IP rate
// limits. The client IP is used only for the rate limit and never stored. The
// stats routes and the dashboard answer only requests that passed Cloudflare
// Access (access.mjs: ACCESS_TEAM_DOMAIN, ACCESS_AUD); without those vars they
// answer 403. Only the local dev server opens them (DASHBOARD_ACCESS = 'open').
// Optional vars: COMPAT_DATA_URL (game names), DASHBOARD_LABEL (a badge on the
// dashboard, such as "Synthetic data").

import {
  MAX_BODY_BYTES, MAX_JSON_BYTES, NO_APP_FRAMES, RETENTION_DAYS, SOURCE_RANK, UNCLEAN_ENDS,
  cleanEnvelope, compatNames, crashFrames, crashKind, crashSignature, dayOffset, deviceClass,
  histogramCounts, histogramStats, issueDraft, loadSymbolMap, mergeSymbolMaps, messageKey, pacingOf,
  sessionStats, symbolicateFrames, verifyAttestation, INTERVAL_BUCKETS,
} from './lib.mjs';
import {verifyAccess} from './access.mjs';
import {DASHBOARD_HTML} from './dashboard.mjs';
import {stats} from './stats.mjs';

// Subrequests one cron run may make: D1 queries (a batch counts once) and
// fetches. The Free plan allows 50. Each step takes what it needs and leaves
// the rest for the next run.
const CRON_REQUESTS = 45;
// Unsigned crashes read per cron run; those the budget doesn't reach wait.
const CRON_BATCH = 50;
// Symbol maps looked up per run (one per build that crashed).
const MAX_SYMBOL_MAPS = 4;
// Triage issues opened and updated per cron run, and the reports a crash
// group needs before it gets one.
const MAX_NEW_ISSUES = 5;
const MAX_ISSUE_UPDATES = 5;
const ISSUE_MIN_REPORTS = 2;
const MAX_LIST = 20;
// Game names, and each game's status on its main platform (iOS for most).
const COMPAT_DATA_URL = 'https://xenios.jp/compatibility/search-index.json';
// Title IDs the compatibility list doesn't have are looked up again after this.
const NAME_RECHECK_DAYS = 7;
const HISTOGRAM_COLUMNS = INTERVAL_BUCKETS.map((_, i) => `h${i}`);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
}

// ---- Ingest

// |stream| that errors with a RangeError past |limit| bytes.
function capped(stream, limit) {
  let size = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) {
        controller.error(new RangeError('too large'));
      } else {
        controller.enqueue(chunk);
      }
    },
  }));
}

// Sizes are checked as the body streams in, before and after inflating, so
// neither a false Content-Length nor a gzip bomb gets far.
async function readBody(request) {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > MAX_BODY_BYTES) return {error: 'too large', status: 413};
  if (!request.body) return {error: 'empty', status: 400};
  let body = capped(request.body, MAX_BODY_BYTES);
  if (request.headers.get('Content-Encoding') === 'gzip') {
    body = body.pipeThrough(new DecompressionStream('gzip'));
  }
  let text;
  try {
    text = await new Response(capped(body, MAX_JSON_BYTES)).text();
  } catch (e) {
    return e instanceof RangeError ? {error: 'too large', status: 413}
                                   : {error: 'bad encoding', status: 400};
  }
  try {
    return {envelope: JSON.parse(text)};
  } catch {
    return {error: 'bad json', status: 400};
  }
}

function insert(table, row, verb = 'INSERT OR IGNORE') {
  const columns = Object.keys(row);
  return [`${verb} INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          Object.values(row)];
}

function sessionRow(clean, day) {
  const b = clean.body;
  const stats = sessionStats(b) ?? {};
  const counts = histogramCounts(b);
  return {
    id: clean.id, day, build_id: clean.build.buildId, official: clean.build.official ? 1 : 0,
    model: clean.device.model, device_class: deviceClass(clean.device.model),
    os: clean.device.os ?? null, title_id: b.titleId ?? null, end_reason: b.end ?? 'unknown',
    duration_s: b.durationS ?? null, active_s: b.activeS ?? null, frames: b.frames ?? null,
    first_frame_ms: b.firstFrameMs ?? null, median_fps: stats.medianFps ?? null,
    low1_fps: stats.low1Fps ?? null, stutter_pct: stats.stutterPct ?? null,
    severe_frames: stats.severeFrames ?? null, long_frames: b.longFrames ?? null,
    long_frames_compiling: b.longFramesDuringShaderCompile ?? null,
    pipelines_compiled: b.pipelinesCompiled ?? null, stored_pipelines: b.storedPipelines ?? null,
    gpu_errors: b.gpuErrors ?? null,
    thermal_nominal_s: b.thermalS?.nominal ?? null, thermal_fair_s: b.thermalS?.fair ?? null,
    thermal_serious_s: b.thermalS?.serious ?? null,
    thermal_critical_s: b.thermalS?.critical ?? null, low_power_s: b.lowPowerS ?? null,
    peak_footprint_mb: b.peakFootprintMB ?? null, min_available_mb: b.minAvailableMB ?? null,
    memory_warnings: b.memoryWarnings ?? null, pacing: pacingOf(b),
    framerate_limit: b.framerateLimit ?? null,
    ...Object.fromEntries(HISTOGRAM_COLUMNS.map((h, i) => [h, counts ? counts[i] : null])),
  };
}

function crashRow(clean, day) {
  const b = clean.body;
  return {
    id: clean.id, day, build_id: clean.build.buildId, official: clean.build.official ? 1 : 0,
    model: clean.device.model, device_class: deviceClass(clean.device.model),
    os: clean.device.os ?? null, title_id: b.titleId ?? null, source: b.source,
    launch_id: b.launchId ?? null, binary_uuid: b.binaryUUID ?? clean.build.binaryUUID ?? null,
    kind: crashKind(b), message: b.message ?? b.terminationReason ?? null,
    fault_address: b.faultAddress ?? null, frames: JSON.stringify(crashFrames(b)),
  };
}

function prepared(env, [sql, args]) {
  return env.DB.prepare(sql).bind(...args);
}

export async function ingest(request, env, now = new Date()) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.LIMITER) {
    const {success} = await env.LIMITER.limit({key: ip});
    if (!success) return new Response('slow down', {status: 429});
  }
  const {envelope, error, status} = await readBody(request);
  if (error) return new Response(error, {status});
  const clean = cleanEnvelope(envelope);
  if (clean.error) return new Response(clean.error, {status: 400});
  const att = envelope.build?.attestation ?? {};
  clean.build.official = await verifyAttestation(att.payload, att.signature, env.ATTESTATION_KEY,
                                                 clean.build.buildId);
  const day = now.toISOString().slice(0, 10);
  clean.receivedDay = day;  // The server's day; records carry no time.

  await store(env, clean, day);
  return new Response(null, {status: 204});
}

// The D1 row of one cleaned record and its raw copy, in one batch (also used
// to rebuild the tables from the raw copies).
export async function store(env, clean, day) {
  const row = clean.kind === 'session' ? ['sessions', sessionRow(clean, day)]
                                       : ['crashes', crashRow(clean, day)];
  await env.DB.batch([
    prepared(env, insert(...row)),
    prepared(env, insert('raw', {id: clean.id, day, kind: clean.kind, record: JSON.stringify(clean)})),
  ]);
}

// ---- Cron

class OutOfBudget extends Error {}

// The cron's subrequests left (CRON_REQUESTS).
class Budget {
  constructor(requests) {
    this.left = requests;
  }
  // Takes |n| subrequests, or throws OutOfBudget when they aren't left.
  take(n = 1) {
    if (n > this.left) throw new OutOfBudget(`needs ${n}, ${this.left} left`);
    this.left -= n;
  }
}

function storedFrames(crash) {
  try {
    const frames = JSON.parse(crash.frames);
    return Array.isArray(frames) ? frames : [];
  } catch {
    return [];
  }
}

// Maps for the builds that crashed (the record's binary, or its XeniOS
// frames'), at most MAX_SYMBOL_MAPS of them, each with only the chunks the
// frames fall in: one query per build.
async function symbolMaps(env, crashes, budget) {
  const offsets = new Map();
  for (const crash of crashes) {
    for (const frame of storedFrames(crash)) {
      const uuid = frame?.binaryUUID ?? crash.binary_uuid;
      if (frame?.image !== 'XeniOS' || frame.symbol || !uuid || !/^0x[0-9a-f]+$/i.test(frame.offset ?? '')) continue;
      if (!offsets.has(uuid)) {
        if (offsets.size >= MAX_SYMBOL_MAPS) continue;
        offsets.set(uuid, new Set());
      }
      offsets.get(uuid).add(Number(BigInt(frame.offset)));
    }
  }
  const maps = new Map();
  for (const [uuid, wanted] of offsets) {
    budget.take();
    const {results} = await env.DB.prepare(
        `SELECT DISTINCT c.start, c.data FROM json_each(?2) o JOIN symbol_chunks c
           ON c.uuid = ?1 AND c.start = (SELECT MAX(start) FROM symbol_chunks
                                         WHERE uuid = ?1 AND start <= o.value)`)
        .bind(uuid, JSON.stringify([...wanted])).all();
    const parts = await Promise.all(results.map((r) => loadSymbolMap(new Uint8Array(r.data))));
    maps.set(uuid, parts.length ? mergeSymbolMaps(parts) : null);
  }
  return maps;
}

// Adds one report to a crash group, in one statement: the group's lists
// (builds, titles, devices) keep their first MAX_LIST distinct values.
function countGroupStatement(env, signature, crash) {
  const append = (column, n) =>
    `${column} = CASE WHEN ?${n} IS NULL OR json_array_length(${column}) >= ${MAX_LIST} OR
       EXISTS (SELECT 1 FROM json_each(crash_groups.${column}) WHERE value = ?${n})
       THEN ${column} ELSE json_insert(${column}, '$[#]', ?${n}) END`;
  return env.DB.prepare(
      `INSERT INTO crash_groups (signature, first_day, last_day, count, builds, titles, models)
       VALUES (?1, ?2, ?2, 1, json_array(?3),
               CASE WHEN ?4 IS NULL THEN '[]' ELSE json_array(?4) END, json_array(?5))
       ON CONFLICT (signature) DO UPDATE SET count = count + 1,
         first_day = MIN(first_day, ?2), last_day = MAX(last_day, ?2),
         ${append('builds', 3)}, ${append('titles', 4)}, ${append('models', 5)}, dirty = 1`)
      .bind(signature, crash.day, crash.build_id, crash.title_id ?? null, crash.model);
}

function uncountGroupStatement(env, signature) {
  return env.DB.prepare(
      'UPDATE crash_groups SET count = MAX(0, count - 1), dirty = 1 WHERE signature = ?')
      .bind(signature);
}

function signatureOf(crash, frames) {
  const note = crash.message === null ? null
             : crash.source === 'metrickit' ? crash.message.split('\n')[0].trim().slice(0, 120)
             : crash.kind === 'fatal' ? messageKey(crash.message) : null;
  const prefix = crash.source === 'metrickit' ? '[metrickit] ' : '';
  return prefix + crashSignature(crash.kind, frames, note);
}

// Signs, deduplicates and counts one crash. Every change it makes lands in
// one batch.
async function signCrash(env, crash, maps, budget) {
  const frames = symbolicateFrames(JSON.parse(crash.frames), maps, crash.binary_uuid);
  const signature = signatureOf(crash, frames);
  const statements = [];
  // The same launch reported more than once (app, extension, MetricKit): the
  // richest report counts. One without XeniOS frames (the extension finds no
  // crashed thread when Xenia's handler recorded nothing) ranks last.
  const rank = (source, sig) => SOURCE_RANK[source] +
      (sig.endsWith(NO_APP_FRAMES) ? Object.keys(SOURCE_RANK).length : 0);
  let duplicateOf = null;
  if (crash.launch_id) {
    budget.take();
    const {results: others} = await env.DB.prepare(
        `SELECT id, source, signature, official FROM crashes
         WHERE launch_id = ? AND id != ? AND duplicate_of IS NULL AND signature IS NOT NULL`)
        .bind(crash.launch_id, crash.id).all();
    for (const other of others) {
      if (rank(other.source, other.signature) <= rank(crash.source, signature)) {
        duplicateOf = other.id;
      } else {
        // The reports that were duplicates of |other| move with it.
        statements.push(env.DB.prepare(
            'UPDATE crashes SET duplicate_of = ?1 WHERE id = ?2 OR duplicate_of = ?2')
            .bind(crash.id, other.id));
        if (other.official) statements.push(uncountGroupStatement(env, other.signature));
      }
    }
  }
  if (duplicateOf) statements.splice(0);
  statements.push(env.DB.prepare(
      'UPDATE crashes SET signature = ?, frames = ?, duplicate_of = ? WHERE id = ?')
      .bind(signature, JSON.stringify(frames), duplicateOf, crash.id));
  if (!duplicateOf && crash.official) statements.push(countGroupStatement(env, signature, crash));
  budget.take();
  await env.DB.batch(statements);
}

// Signs the oldest unsigned crashes the budget reaches, keeping |reserve|
// subrequests; a crash takes two (three when it can't be signed).
async function signCrashes(env, budget, reserve = 0) {
  budget.take();
  const {results} = await env.DB.prepare(
      `SELECT id, day, build_id, official, model, title_id, source, launch_id, binary_uuid, kind,
         message, frames
       FROM crashes WHERE signature IS NULL ORDER BY day LIMIT ?`).bind(CRON_BATCH).all();
  if (!results.length) return;
  const maps = await symbolMaps(env, results, budget);
  for (const crash of results) {
    if (budget.left < 3 + reserve) return;
    try {
      await signCrash(env, crash, maps, budget);
    } catch (e) {
      // Kept out of the groups, so one bad record can't hold up the cron.
      console.error(`cron: crash ${crash.id} not signed:`, e);
      budget.take();
      await env.DB.prepare("UPDATE crashes SET signature = '<unsigned>' WHERE id = ?")
          .bind(crash.id).run();
    }
  }
}

async function sendIssue(env, group, fetchImpl, budget) {
  const draft = issueDraft(group);
  let number = group.issue_number;
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    budget.take();
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/issues` + (number ? `/${number}` : '');
    const response = await fetchImpl(url, {
      method: number ? 'PATCH' : 'POST',
      headers: {'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json',
                'User-Agent': 'xenios-diagnostics'},
      body: JSON.stringify(number ? {body: draft.body} : {...draft, labels: ['crash']}),
    });
    if (!response.ok) return;
    number = number ?? (await response.json()).number;
  }
  budget.take();
  await env.DB.prepare(
      'UPDATE crash_groups SET issue_number = ?, issue_draft = ?, dirty = 0 WHERE signature = ?')
      .bind(number ?? null, JSON.stringify(draft), group.signature).run();
}

// Without a token (locally, in tests) the issue text is only kept as a draft.
// New issues are rationed, so a burst of new signatures can't flood the repo.
function issueRequests(env) {
  return 2 + (MAX_NEW_ISSUES + MAX_ISSUE_UPDATES) * (env.GITHUB_TOKEN && env.GITHUB_REPO ? 2 : 1);
}

async function syncIssues(env, fetchImpl, budget) {
  budget.take(2);
  const [updates, fresh] = await Promise.all([
    env.DB.prepare(`SELECT * FROM crash_groups WHERE dirty = 1 AND issue_number IS NOT NULL
                    LIMIT ?`).bind(MAX_ISSUE_UPDATES).all(),
    env.DB.prepare(`SELECT * FROM crash_groups WHERE dirty = 1 AND issue_number IS NULL
                    AND count >= ? ORDER BY count DESC LIMIT ?`)
        .bind(ISSUE_MIN_REPORTS, MAX_NEW_ISSUES).all(),
  ]);
  for (const group of [...updates.results, ...fresh.results]) {
    if (budget.left < (env.GITHUB_TOKEN && env.GITHUB_REPO ? 2 : 1)) return;
    await sendIssue(env, group, fetchImpl, budget);
  }
}

export async function rollUpDay(env, day, budget = new Budget(2)) {
  budget.take(2);
  const {results} = await env.DB.prepare('SELECT * FROM sessions WHERE day = ?').bind(day).all();
  const groups = new Map();
  for (const s of results) {
    const key = [s.build_id, s.official, s.title_id ?? '', s.device_class, s.pacing].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const statements = [env.DB.prepare('DELETE FROM daily_title WHERE day = ?').bind(day)];
  const sum = (sessions, f) => sessions.reduce((a, s) => a + (f(s) ?? 0), 0);
  for (const sessions of groups.values()) {
    const first = sessions[0];
    const counts = HISTOGRAM_COLUMNS.map((h) => sum(sessions, (s) => s[h]));
    const pooled = counts.some(Boolean) ? histogramStats(counts) : {};
    statements.push(prepared(env, insert('daily_title', {
      day, build_id: first.build_id, official: first.official, title_id: first.title_id ?? '',
      device_class: first.device_class, pacing: first.pacing, sessions: sessions.length,
      unclean: sessions.filter((s) => UNCLEAN_ENDS.has(s.end_reason)).length,
      killed: sessions.filter((s) => s.end_reason === 'killed').length,
      play_s: sum(sessions, (s) => s.active_s), hot_s: sum(sessions, (s) =>
        (s.thermal_serious_s ?? 0) + (s.thermal_critical_s ?? 0)),
      long_frames: sum(sessions, (s) => s.long_frames),
      long_frames_compiling: sum(sessions, (s) => s.long_frames_compiling),
      gpu_error_sessions: sessions.filter((s) => s.gpu_errors > 0).length,
      cold_sessions: sessions.filter((s) => s.stored_pipelines === 0).length,
      cache_known_sessions: sessions.filter((s) => s.stored_pipelines !== null).length,
      median_fps: pooled.medianFps ?? null, low1_fps: pooled.low1Fps ?? null,
      stutter_pct: pooled.stutterPct ?? null,
      ...Object.fromEntries(HISTOGRAM_COLUMNS.map((h, i) => [h, counts[i]])),
    }, 'INSERT')));
  }
  await env.DB.batch(statements);
}

// Names for the title IDs seen, from the compatibility list: fetched only when
// one is new, or one the list lacked is due another look.
export async function refreshTitleNames(env, today, fetchImpl = fetch, budget = new Budget(3)) {
  budget.take(3);
  const {results} = await env.DB.prepare(
      `SELECT DISTINCT s.title_id FROM sessions s LEFT JOIN title_names n ON n.title_id = s.title_id
       WHERE s.title_id IS NOT NULL AND (n.title_id IS NULL OR (n.name IS NULL AND n.checked_day < ?))
       UNION
       SELECT DISTINCT c.title_id FROM crashes c LEFT JOIN title_names n ON n.title_id = c.title_id
       WHERE c.title_id IS NOT NULL AND (n.title_id IS NULL OR (n.name IS NULL AND n.checked_day < ?))`)
      .bind(dayOffset(today, -NAME_RECHECK_DAYS), dayOffset(today, -NAME_RECHECK_DAYS)).all();
  if (!results.length) return;
  let titles;
  try {
    const response = await fetchImpl(env.COMPAT_DATA_URL ?? COMPAT_DATA_URL);
    if (!response.ok) return;
    titles = compatNames(await response.text(), results.map((r) => r.title_id));
  } catch {
    return;
  }
  await env.DB.batch(results.map(({title_id}) => {
    const found = titles.get(title_id);
    return prepared(env, insert('title_names', {
      title_id, name: found?.name ?? null, status: found?.status ?? null, checked_day: today,
    }, 'INSERT OR REPLACE'));
  }));
}

async function deleteOldRawData(env, today, budget) {
  const cutoff = dayOffset(today, -RETENTION_DAYS);
  budget.take();
  await env.DB.batch([
    ...['sessions', 'crashes', 'raw'].map(
        (table) => env.DB.prepare(`DELETE FROM ${table} WHERE day < ?`).bind(cutoff)),
    // Title IDs no record names any more, that the compatibility list lacked.
    env.DB.prepare(`DELETE FROM title_names WHERE name IS NULL
                    AND title_id NOT IN (SELECT title_id FROM sessions WHERE title_id IS NOT NULL)
                    AND title_id NOT IN (SELECT title_id FROM crashes WHERE title_id IS NOT NULL)`),
  ]);
}

// Each step runs whatever happened to the ones before, so retention never
// waits on a bad record. Signing takes the subrequests left but what issues
// need; a step the budget stops resumes at the next run.
export async function runCron(env, now = new Date(), fetchImpl = fetch, requests = CRON_REQUESTS) {
  const today = now.toISOString().slice(0, 10);
  const budget = new Budget(requests);
  const steps = [
    ['roll up', async () => {
      await rollUpDay(env, dayOffset(today, -1), budget);
      await rollUpDay(env, today, budget);
    }],
    ['names', () => refreshTitleNames(env, today, fetchImpl, budget)],
    ['retention', () => deleteOldRawData(env, today, budget)],
    ['sign', () => signCrashes(env, budget, issueRequests(env))],
    ['issues', () => syncIssues(env, fetchImpl, budget)],
  ];
  let failed = null;
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      if (e instanceof OutOfBudget) continue;
      console.error(`cron ${name}:`, e);
      failed ??= e;
    }
  }
  if (failed) throw failed;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; connect-src 'self'; " +
      "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/v1/diag') {
    return request.method === 'POST' ? ingest(request, env)
                                     : new Response('method not allowed', {status: 405});
  }
  if (request.method !== 'GET') return new Response('not found', {status: 404});
  if (env.DASHBOARD_ACCESS !== 'open' && !await verifyAccess(request, env)) {
    return new Response('forbidden', {status: 403});
  }
  if (url.pathname === '/') return new Response(DASHBOARD_HTML, {headers: PAGE_HEADERS});
  const match = url.pathname.match(/^\/v1\/stats\/([a-z]+)$/);
  const result = match ? await stats(match[1], env, url) : null;
  return result ? json(result) : new Response('not found', {status: 404});
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('request failed:', e);
      return new Response('server error', {status: 500});
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },
};
