// Dashboard data: GET /v1/stats/<view>?days=7&unofficial=1&build=<id>&device=<chip>,
// plus title=<id> (view title) or signature=<text> (view crash).
//
// Everything reads the raw rows, so a range is at most RETENTION_DAYS. Frame
// pacing comes from the summed frame interval histograms of capped play (the
// default setting); uncapped play runs the guest as fast as it goes and is
// shown apart. Crash counts leave out duplicate reports of one launch.

import {
  INTERVAL_BUCKETS, INTERVAL_EDGES_MS, RETENTION_DAYS, dayOffset, histogramStats,
} from './lib.mjs';

const H = INTERVAL_BUCKETS.map((_, i) => `h${i}`);
const HOT = 'COALESCE(thermal_serious_s, 0) + COALESCE(thermal_critical_s, 0)';
const histogramSums = (pacing) => H.map(
    (h) => `SUM(CASE WHEN pacing = '${pacing}' THEN ${h} END) AS ${pacing[0]}${h}`).join(', ');

// The columns every group of sessions reports; summarize() reads them.
const SESSION_SUMS = `COUNT(*) AS sessions,
  SUM(end_reason IN ('crash', 'fatal', 'killed')) AS unclean,
  SUM(end_reason = 'crash') AS crashed, SUM(end_reason = 'fatal') AS fatal,
  SUM(end_reason = 'killed') AS killed,
  SUM(COALESCE(active_s, 0)) AS play_s, SUM(COALESCE(duration_s, 0)) AS duration_s,
  SUM(${HOT}) AS hot_s, SUM(COALESCE(long_frames, 0)) AS long_frames,
  SUM(COALESCE(long_frames_compiling, 0)) AS compiling,
  SUM(CASE WHEN pacing != 'capped' THEN COALESCE(active_s, 0) ELSE 0 END) AS uncapped_s,
  SUM(gpu_errors > 0) AS gpu_error_sessions,
  SUM(stored_pipelines = 0) AS cold_sessions, COUNT(stored_pipelines) AS cache_known,
  SUM(CASE WHEN stored_pipelines = 0 THEN long_frames END) AS cold_long_frames,
  SUM(CASE WHEN stored_pipelines = 0 THEN active_s END) AS cold_play_s,
  SUM(CASE WHEN stored_pipelines > 0 THEN long_frames END) AS warm_long_frames,
  SUM(CASE WHEN stored_pipelines > 0 THEN active_s END) AS warm_play_s,
  ${histogramSums('capped')}`;

const CRASHES = 'duplicate_of IS NULL AND signature IS NOT NULL';

function counts(row, prefix) {
  return H.map((h) => Number(row[prefix + h] ?? 0));
}

const round = (x, digits = 1) => (x === null || !Number.isFinite(x) ? null
                                                                    : Number(x.toFixed(digits)));
const share = (part, whole, digits = 1) => (whole ? round(100 * part / whole, digits) : null);
const perMinute = (n, seconds) => (seconds ? round(Number(n ?? 0) / (seconds / 60), 2) : null);

// One group of sessions as the dashboard shows it.
function summarize(row) {
  const sessions = Number(row.sessions ?? 0);
  const playS = Number(row.play_s ?? 0);
  const histogram = counts(row, 'c');
  const frames = histogram.reduce((a, b) => a + b, 0);
  const pacing = frames ? histogramStats(histogram) : {};
  return {
    sessions,
    crashFreePct: share(sessions - Number(row.unclean ?? 0), sessions, 2),
    crashed: Number(row.crashed ?? 0),
    fatal: Number(row.fatal ?? 0),
    killed: Number(row.killed ?? 0),
    playHours: round(playS / 3600, 2),
    hotPct: share(Number(row.hot_s ?? 0), Number(row.duration_s ?? 0)),
    hitchesPerMin: perMinute(row.long_frames, playS),
    compilePct: share(Number(row.compiling ?? 0), Number(row.long_frames ?? 0)),
    uncappedPct: share(Number(row.uncapped_s ?? 0), playS),
    gpuErrorPct: share(Number(row.gpu_error_sessions ?? 0), sessions),
    // First runs (no stored shaders) against the rest, where reported.
    coldPct: share(Number(row.cold_sessions ?? 0), Number(row.cache_known ?? 0)),
    hitchesPerMinCold: perMinute(row.cold_long_frames, Number(row.cold_play_s ?? 0)),
    hitchesPerMinWarm: perMinute(row.warm_long_frames, Number(row.warm_play_s ?? 0)),
    frames,
    medianFps: pacing.medianFps ?? null,
    low1Fps: pacing.low1Fps ?? null,
    stutterPct: pacing.stutterPct ?? null,
  };
}

// The range and filters of a request. where() gives the SQL and arguments for
// a day range with the filters; {only: 'official'} keeps just the build kind
// (for the filter menus).
function scope(url, now) {
  const p = url.searchParams;
  const days = Math.max(1, Math.min(Math.floor(Number(p.get('days'))) || 7, RETENTION_DAYS));
  const today = now.toISOString().slice(0, 10);
  const since = dayOffset(today, 1 - days);
  const filters = [];
  if (p.get('unofficial') !== '1') filters.push(['official = 1']);
  if (p.get('build')) filters.push(['build_id = ?', p.get('build').slice(0, 96)]);
  if (p.get('device')) filters.push(['device_class = ?', p.get('device').slice(0, 40)]);
  return {
    days, today, since, previous: [dayOffset(since, -days), dayOffset(since, -1)],
    where(from = since, to = today, {alias = '', only = null} = {}) {
      const used = only === 'official' ? filters.slice(0, p.get('unofficial') === '1' ? 0 : 1)
                                       : filters;
      const sql = [`${alias}day >= ?`, `${alias}day <= ?`,
                   ...used.map(([clause]) => alias + clause)].join(' AND ');
      return [sql, [from, to, ...used.slice().flatMap(([, arg]) => (arg === undefined ? [] : [arg]))]];
    },
  };
}

function db(env) {
  const all = (sql, args = []) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);
  const first = (sql, args = []) => env.DB.prepare(sql).bind(...args).first();
  return {all, first};
}

// Percentiles of a session column per group, from window functions:
// {key: {p50, p90}}. tenths: the percentiles wanted, in tenths.
async function percentiles(q, column, key, [where, args], tenths = [5, 9]) {
  const picks = tenths.map((t) =>
    `MAX(CASE WHEN rn = (${t} * n + 9) / 10 THEN x END) AS p${t}0`).join(', ');
  const rows = await q.all(
      `SELECT k, ${picks} FROM (
         SELECT ${key} AS k, ${column} AS x,
           ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ${column}) AS rn,
           COUNT(*) OVER (PARTITION BY ${key}) AS n
         FROM sessions WHERE ${where} AND ${column} IS NOT NULL)
       GROUP BY k`, args);
  return Object.fromEntries(rows.map(({k, ...rest}) => [k, rest]));
}

const byKey = (rows, key = 'key') => Object.fromEntries(rows.map((r) => [r[key], r]));
const seconds = (ms) => (ms === null || ms === undefined ? null : round(ms / 1000));

// ---- Views

async function meta(q, s, env) {
  const official = s.where(s.since, s.today, {only: 'official'});
  const [builds, devices] = await Promise.all([
    q.all(`SELECT build_id, MAX(official) AS official, COUNT(*) AS sessions, MAX(day) AS last_day
           FROM sessions WHERE ${official[0]} GROUP BY build_id
           ORDER BY last_day DESC, build_id DESC LIMIT 100`, official[1]),
    q.all(`SELECT device_class, COUNT(*) AS sessions FROM sessions WHERE ${official[0]}
           GROUP BY device_class ORDER BY sessions DESC`, official[1]),
  ]);
  return {label: env.DASHBOARD_LABEL || null, today: s.today, since: s.since, days: s.days,
          edges: INTERVAL_EDGES_MS, buckets: INTERVAL_BUCKETS.map((b) => b.label), builds,
          devices};
}

async function titles(q, s, {limit = 500} = {}) {
  const [where, args] = s.where();
  const [rows, crashes, firstFrame] = await Promise.all([
    q.all(`SELECT s.title_id, n.name, n.status, ${SESSION_SUMS},
             COUNT(DISTINCT device_class) AS devices, MAX(day) AS last_day
           FROM sessions s LEFT JOIN title_names n ON n.title_id = s.title_id
           WHERE ${where} AND s.title_id IS NOT NULL
           GROUP BY s.title_id ORDER BY play_s DESC, sessions DESC LIMIT ?`, [...args, limit]),
    q.all(`SELECT title_id, COUNT(*) AS n FROM crashes WHERE ${where} AND ${CRASHES}
           AND title_id IS NOT NULL GROUP BY title_id`, args),
    percentiles(q, 'first_frame_ms', 'title_id', [where, args], [5]),
  ]);
  const crashCount = byKey(crashes, 'title_id');
  return rows.map((r) => ({
    titleId: r.title_id, name: r.name, status: r.status, devices: r.devices, lastDay: r.last_day,
    crashReports: crashCount[r.title_id]?.n ?? 0,
    firstFrameS: seconds(firstFrame[r.title_id]?.p50), ...summarize(r),
  }));
}

async function crashGroups(q, s, {limit = 100} = {}) {
  const [where, args] = s.where(s.since, s.today, {alias: 'c.'});
  // A group is new when the builds shown (official, or all) first had it in
  // the range.
  const [ever, everArgs] = s.where('0000-00-00', s.today, {only: 'official'});
  const [rows, days, games] = await Promise.all([
    q.all(`SELECT c.signature, MAX(c.kind) AS kind, COUNT(*) AS reports,
             COUNT(DISTINCT c.model) AS models, COUNT(DISTINCT c.build_id) AS builds,
             COUNT(DISTINCT c.title_id) AS titles, MAX(c.day) AS last_day,
             GROUP_CONCAT(DISTINCT c.source) AS sources, f.first_day, g.issue_number
           FROM crashes c
           JOIN (SELECT signature, MIN(day) AS first_day FROM crashes
                 WHERE ${ever} AND ${CRASHES} GROUP BY signature) f ON f.signature = c.signature
           LEFT JOIN crash_groups g ON g.signature = c.signature
           WHERE ${where} AND c.duplicate_of IS NULL AND c.signature IS NOT NULL
           GROUP BY c.signature ORDER BY reports DESC, last_day DESC LIMIT ?`,
          [...everArgs, ...args, limit]),
    q.all(`SELECT c.signature, c.day, COUNT(*) AS n FROM crashes c
           WHERE ${where} AND c.duplicate_of IS NULL AND c.signature IS NOT NULL
           GROUP BY c.signature, c.day`, args),
    q.all(`SELECT c.signature, c.title_id, n.name, COUNT(*) AS n FROM crashes c
           LEFT JOIN title_names n ON n.title_id = c.title_id
           WHERE ${where} AND c.duplicate_of IS NULL AND c.signature IS NOT NULL
             AND c.title_id IS NOT NULL
           GROUP BY c.signature, c.title_id ORDER BY n DESC`, args),
  ]);
  const perDay = new Map();
  for (const d of days) {
    if (!perDay.has(d.signature)) perDay.set(d.signature, {});
    perDay.get(d.signature)[d.day] = d.n;
  }
  const topGames = new Map();
  for (const g of games) {
    if (!topGames.has(g.signature)) topGames.set(g.signature, []);
    const list = topGames.get(g.signature);
    if (list.length < 3) list.push({titleId: g.title_id, name: g.name, reports: g.n});
  }
  return rows.map((r) => ({
    signature: r.signature, kind: r.kind, reports: r.reports, models: r.models, builds: r.builds,
    titles: r.titles, firstDay: r.first_day, lastDay: r.last_day, isNew: r.first_day >= s.since,
    sources: String(r.sources ?? '').split(',').filter(Boolean).sort(),
    issueNumber: r.issue_number ?? null, perDay: perDay.get(r.signature) ?? {},
    topGames: topGames.get(r.signature) ?? [],
  }));
}

async function overview(q, s) {
  const current = s.where();
  const previous = s.where(...s.previous);
  const groupFilters = s.where('0000-00-00', s.today, {only: 'official'});
  const [now, before, crashNow, crashBefore, fresh, daily, topTitles, topCrashes] =
      await Promise.all([
        q.first(`SELECT ${SESSION_SUMS} FROM sessions WHERE ${current[0]}`, current[1]),
        q.first(`SELECT ${SESSION_SUMS} FROM sessions WHERE ${previous[0]}`, previous[1]),
        q.first(`SELECT COUNT(*) AS reports, COUNT(DISTINCT signature) AS groups FROM crashes
                 WHERE ${current[0]} AND ${CRASHES}`, current[1]),
        q.first(`SELECT COUNT(*) AS reports, COUNT(DISTINCT signature) AS groups FROM crashes
                 WHERE ${previous[0]} AND ${CRASHES}`, previous[1]),
        q.first(`SELECT COUNT(*) AS n FROM (SELECT MIN(day) AS first_day FROM crashes
                 WHERE ${groupFilters[0]} AND ${CRASHES} GROUP BY signature) WHERE first_day >= ?`,
                [...groupFilters[1], s.since]),
        q.all(`SELECT day, ${SESSION_SUMS} FROM sessions WHERE ${current[0]} GROUP BY day`,
              current[1]),
        titles(q, s, {limit: 6}),
        crashGroups(q, s, {limit: 6}),
      ]);
  return {
    current: {...summarize(now ?? {}), crashReports: crashNow?.reports ?? 0,
              crashGroups: crashNow?.groups ?? 0, newGroups: fresh?.n ?? 0},
    previous: {...summarize(before ?? {}), crashReports: crashBefore?.reports ?? 0,
               crashGroups: crashBefore?.groups ?? 0},
    daily: daily.map((d) => ({day: d.day, ...summarize(d)})),
    topTitles, topCrashes,
  };
}

async function title(q, s, titleId) {
  if (!/^[0-9A-F]{8}$/.test(titleId ?? '')) return null;
  const [w, a] = s.where();
  const where = `${w} AND title_id = ?`;
  const args = [...a, titleId];
  const groupBy = (key, extra = '') => q.all(
      `SELECT ${key} AS key${extra}, ${SESSION_SUMS} FROM sessions WHERE ${where}
       GROUP BY ${key} ORDER BY sessions DESC LIMIT 40`, args);
  const [summary, name, daily, devices, builds, ends, limits, pacing, memory, crashes] =
      await Promise.all([
        q.first(`SELECT ${SESSION_SUMS}, ${histogramSums('uncapped')} FROM sessions
                 WHERE ${where}`, args),
        q.first('SELECT name, status FROM title_names WHERE title_id = ?', [titleId]),
        q.all(`SELECT day, ${SESSION_SUMS} FROM sessions WHERE ${where} GROUP BY day`, args),
        groupBy('device_class'),
        groupBy('build_id', ', MAX(official) AS official, MAX(day) AS last_day'),
        q.all(`SELECT end_reason AS key, COUNT(*) AS sessions FROM sessions WHERE ${where}
               GROUP BY end_reason ORDER BY sessions DESC`, args),
        q.all(`SELECT COALESCE(framerate_limit, 0) AS key, COUNT(*) AS sessions,
                 SUM(COALESCE(active_s, 0)) AS play_s FROM sessions WHERE ${where}
               GROUP BY key ORDER BY play_s DESC`, args),
        q.all(`SELECT pacing AS key, COUNT(*) AS sessions, SUM(COALESCE(active_s, 0)) AS play_s
               FROM sessions WHERE ${where} GROUP BY pacing ORDER BY play_s DESC`, args),
        Promise.all([
          percentiles(q, 'peak_footprint_mb', "'all'", [where, args]),
          percentiles(q, 'min_available_mb', "'all'", [where, args], [1, 5]),
          percentiles(q, 'first_frame_ms', "'all'", [where, args]),
          percentiles(q, 'pipelines_compiled', "'all'", [where, args]),
        ]),
        q.all(`SELECT signature, COUNT(*) AS reports, MAX(day) AS last_day FROM crashes
               WHERE ${where} AND ${CRASHES} GROUP BY signature ORDER BY reports DESC LIMIT 10`,
              args),
      ]);
  if (!summary?.sessions && !crashes.length) {
    return {titleId, name: name?.name ?? null, status: name?.status ?? null, empty: true};
  }
  const groups = (rows) => rows.map((r) => ({key: r.key, official: r.official,
                                             lastDay: r.last_day, ...summarize(r)}));
  return {
    titleId, name: name?.name ?? null, status: name?.status ?? null,
    summary: summarize(summary),
    histogram: {capped: counts(summary, 'c'), uncapped: counts(summary, 'u')},
    daily: daily.map((d) => ({day: d.day, ...summarize(d)})),
    devices: groups(devices), builds: groups(builds), ends, limits, pacing,
    memory: {peakMB: memory[0].all ?? null, minAvailableMB: memory[1].all ?? null},
    startup: {firstFrameS: memory[2].all ? {p50: seconds(memory[2].all.p50),
                                            p90: seconds(memory[2].all.p90)} : null,
              pipelinesCompiled: memory[3].all ?? null},
    crashes: crashes.map((c) => ({signature: c.signature, reports: c.reports, lastDay: c.last_day})),
  };
}

async function crash(q, s, signature) {
  if (!signature || signature.length > 1000) return null;
  const [w, a] = s.where();
  const [ever, everArgs] = s.where('0000-00-00', s.today, {only: 'official'});
  const where = `${w} AND signature = ? AND duplicate_of IS NULL`;
  const args = [...a, signature];
  const breakdown = (key, join = '') => q.all(
      `SELECT ${key} AS key${join ? ', n.name' : ''}, COUNT(*) AS reports FROM crashes c ${join}
       WHERE ${where.replaceAll('title_id', 'c.title_id')}
       GROUP BY ${key} ORDER BY reports DESC LIMIT 12`, args);
  const [summary, first, group, daily, latest, recent, builds, games, models, oses, sources] =
      await Promise.all([
        q.first(`SELECT COUNT(*) AS reports, COUNT(DISTINCT model) AS models,
                   COUNT(DISTINCT build_id) AS builds, MAX(day) AS last_day, MAX(kind) AS kind
                 FROM crashes WHERE ${where}`, args),
        q.first(`SELECT MIN(day) AS first_day FROM crashes WHERE ${ever} AND signature = ?
                 AND duplicate_of IS NULL`, [...everArgs, signature]),
        q.first('SELECT issue_number, issue_draft FROM crash_groups WHERE signature = ?', [signature]),
        q.all(`SELECT day, COUNT(*) AS n FROM crashes WHERE ${where} GROUP BY day`, args),
        q.first(`SELECT day, build_id, model, os, title_id, source, message, fault_address, frames
                 FROM crashes WHERE ${where} ORDER BY day DESC, rowid DESC LIMIT 1`, args),
        q.all(`SELECT c.day, c.build_id, c.model, c.os, c.title_id, n.name, c.source
               FROM crashes c LEFT JOIN title_names n ON n.title_id = c.title_id
               WHERE ${where.replaceAll('title_id', 'c.title_id')}
               ORDER BY c.day DESC, c.rowid DESC LIMIT 25`, args),
        breakdown('build_id'),
        breakdown('c.title_id', 'LEFT JOIN title_names n ON n.title_id = c.title_id'),
        breakdown('model'),
        breakdown('os'),
        breakdown('source'),
      ]);
  if (!summary?.reports) return {signature, empty: true, firstDay: first?.first_day ?? null};
  let frames = [];
  try {
    frames = JSON.parse(latest.frames);
  } catch {}
  return {
    signature, kind: summary.kind, reports: summary.reports, models: summary.models,
    builds: summary.builds, firstDay: first?.first_day ?? null, lastDay: summary.last_day,
    issueNumber: group?.issue_number ?? null,
    issueDraft: group?.issue_draft ? JSON.parse(group.issue_draft) : null,
    daily: daily.map((d) => ({day: d.day, reports: d.n})),
    latest: {day: latest.day, build: latest.build_id, model: latest.model, os: latest.os,
             titleId: latest.title_id, source: latest.source, message: latest.message,
             faultAddress: latest.fault_address, frames: frames.slice(0, 64)},
    recent: recent.map((r) => ({day: r.day, build: r.build_id, model: r.model, os: r.os,
                                titleId: r.title_id, name: r.name, source: r.source})),
    breakdowns: {builds, games, models, oses, sources},
  };
}

async function devices(q, s) {
  const range = s.where();
  const [classes, footprint, available, models, oses] = await Promise.all([
    q.all(`SELECT device_class AS key, ${SESSION_SUMS}, COUNT(DISTINCT model) AS models,
             SUM(COALESCE(thermal_nominal_s, 0)) AS nominal_s,
             SUM(COALESCE(thermal_fair_s, 0)) AS fair_s,
             SUM(COALESCE(thermal_serious_s, 0)) AS serious_s,
             SUM(COALESCE(thermal_critical_s, 0)) AS critical_s,
             SUM(COALESCE(low_power_s, 0)) AS low_power_s,
             SUM(COALESCE(memory_warnings, 0)) AS warnings
           FROM sessions WHERE ${range[0]} GROUP BY device_class ORDER BY sessions DESC`, range[1]),
    percentiles(q, 'peak_footprint_mb', 'device_class', range),
    percentiles(q, 'min_available_mb', 'device_class', range, [1, 5]),
    q.all(`SELECT model AS key, MAX(device_class) AS device_class, ${SESSION_SUMS},
             MAX(peak_footprint_mb) AS max_footprint_mb, MAX(os) AS latest_os
           FROM sessions WHERE ${range[0]} GROUP BY model ORDER BY sessions DESC LIMIT 60`,
          range[1]),
    q.all(`SELECT COALESCE(os, 'unknown') AS key, ${SESSION_SUMS} FROM sessions
           WHERE ${range[0]} GROUP BY key ORDER BY sessions DESC LIMIT 40`, range[1]),
  ]);
  return {
    classes: classes.map((c) => ({
      key: c.key, models: c.models, ...summarize(c),
      thermal: {nominal: c.nominal_s, fair: c.fair_s, serious: c.serious_s, critical: c.critical_s},
      lowPowerPct: share(c.low_power_s, c.duration_s),
      warningsPerHour: c.play_s ? round(c.warnings / (c.play_s / 3600), 2) : null,
      footprintMB: footprint[c.key] ?? null, availableMB: available[c.key] ?? null,
    })),
    models: models.map((m) => ({key: m.key, deviceClass: m.device_class, latestOs: m.latest_os,
                                maxFootprintMB: m.max_footprint_mb, ...summarize(m)})),
    oses: oses.map((o) => ({key: o.key, ...summarize(o)})),
  };
}

async function builds(q, s) {
  const [where, args] = s.where();
  const [rows, crashes, firstFrame] = await Promise.all([
    q.all(`SELECT build_id, MAX(official) AS official, ${SESSION_SUMS}, MIN(day) AS first_day,
             MAX(day) AS last_day, COUNT(DISTINCT model) AS models,
             COUNT(DISTINCT title_id) AS titles
           FROM sessions WHERE ${where} GROUP BY build_id
           ORDER BY last_day DESC, first_day DESC, build_id DESC LIMIT 100`, args),
    q.all(`SELECT build_id, COUNT(*) AS n, COUNT(DISTINCT signature) AS groups FROM crashes
           WHERE ${where} AND ${CRASHES} GROUP BY build_id`, args),
    percentiles(q, 'first_frame_ms', 'build_id', [where, args], [5]),
  ]);
  const crashCount = byKey(crashes, 'build_id');
  return rows.map((r) => ({
    buildId: r.build_id, official: !!r.official, firstDay: r.first_day, lastDay: r.last_day,
    models: r.models, titles: r.titles, crashReports: crashCount[r.build_id]?.n ?? 0,
    crashGroups: crashCount[r.build_id]?.groups ?? 0,
    firstFrameS: seconds(firstFrame[r.build_id]?.p50), ...summarize(r),
  }));
}

async function crashesView(q, s) {
  const [where, args] = s.where();
  const [groups, daily, totals] = await Promise.all([
    crashGroups(q, s),
    q.all(`SELECT day, ${SESSION_SUMS} FROM sessions WHERE ${where} GROUP BY day`, args),
    q.first(`SELECT COUNT(*) AS reports, COUNT(DISTINCT signature) AS groups,
               COUNT(DISTINCT model) AS models FROM crashes WHERE ${where} AND ${CRASHES}`, args),
  ]);
  return {groups, daily: daily.map((d) => ({day: d.day, ...summarize(d)})),
          reports: totals?.reports ?? 0, models: totals?.models ?? 0,
          newGroups: groups.filter((g) => g.isNew).length};
}

export async function stats(view, env, url, now = new Date()) {
  const q = db(env);
  const s = scope(url, now);
  switch (view) {
    case 'meta': return meta(q, s, env);
    case 'overview': return overview(q, s);
    case 'titles': return titles(q, s);
    case 'title': return title(q, s, (url.searchParams.get('title') ?? '').toUpperCase());
    case 'crashes': return crashesView(q, s);
    case 'crash': return crash(q, s, url.searchParams.get('signature'));
    case 'devices': return devices(q, s);
    case 'builds': return builds(q, s);
    default: return null;
  }
}
