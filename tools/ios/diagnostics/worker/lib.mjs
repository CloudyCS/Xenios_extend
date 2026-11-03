// XeniOS diagnostics: the pure parts of the Worker (no bindings), tested by
// ../test with Node.
//
// Records (the app's src/xenia/ui/ios/shared/ios_diagnostics.h):
//   { schema: 1, kind, id, build: {...}, device: {...}, body: {...} }

// Compressed request bodies up to this, JSON up to MAX_JSON_BYTES.
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
export const KINDS = new Set(['session', 'crash']);
// Raw records are kept this long; the aggregates are kept.
export const RETENTION_DAYS = 90;

// YYYY-MM-DD plus |days|.
export function dayOffset(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- Attestation (matches tools/build_apple_release.sh sign_attestation_payload)

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// The payload's fields ("xenios-build-attestation-v1;platform=ios;...").
function attestationFields(payload) {
  return Object.fromEntries(payload.split(';').slice(1).map((f) => {
    const at = f.indexOf('=');
    return at < 0 ? [f, ''] : [f.slice(0, at), f.slice(at + 1)];
  }));
}

// A build's attestation, signed with the release key and naming this build:
// one copied from another build doesn't make a record official.
export async function verifyAttestation(payload, signature, key, buildId) {
  if (typeof payload !== 'string' || typeof signature !== 'string' || !key) return false;
  if (!payload.startsWith('xenios-build-attestation-v1;') || payload.length > 1024) return false;
  if (buildId !== undefined && attestationFields(payload).buildId !== buildId) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key),
                                          {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload));
  const expected = base64url(mac);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; ++i) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ---- Validation, allowlists and scrubbing
//
// A record keeps only the fields below, each checked for type and range; the
// rest of what was sent is dropped before anything is stored.

const HEX8 = /^[0-9A-F]{8}$/;
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const MODEL = /^(iPhone|iPad|iPod|Mac|RealityDevice)\d+,\d+$/;
const BUILD_ID = /^[A-Za-z0-9._-]{1,96}$/;
const OS = /^\d{1,3}(\.\d{1,3}){1,2}$/;
const HEX = /^0x[0-9a-f]{1,16}$/i;
const SHORT = /^[A-Za-z0-9 ._()+-]{1,32}$/;

const str = (v, re) => (typeof v === 'string' && re.test(v) ? v : undefined);
const uuid = (v) => (typeof v === 'string' && UUID.test(v.toUpperCase()) ? v.toUpperCase()
                                                                          : undefined);
const oneOf = (v, values) => (values.includes(v) ? v : undefined);
// A whole number in 0..max.
const count = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const text = (v, max) => (typeof v === 'string' && v.length ? scrub(v.slice(0, max)) : undefined);

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

const DAY_S = 86400;
const SESSION_ENDS = ['normal', 'crash', 'fatal', 'killed', 'background', 'terminated', 'unknown',
                      'unfinished'];

function sessionBody(b) {
  const thermal = b.thermalS && typeof b.thermalS === 'object' ? b.thermalS : {};
  const numbers = (list, max) => (Array.isArray(list) && list.length <= 16 &&
                                  list.every((x) => typeof x === 'number' && x >= 0 && x <= max)
                                      ? list : undefined);
  return defined({
    titleId: str(b.titleId, HEX8), end: oneOf(b.end, SESSION_ENDS),
    durationS: count(b.durationS, 7 * DAY_S), activeS: count(b.activeS, 7 * DAY_S),
    frames: count(b.frames, 1e8), gaps: count(b.gaps, 1e6),
    intervalMs: numbers(b.intervalMs, 1e4), counts: numbers(b.counts, 1e8),
    longFrames: count(b.longFrames, 1e8),
    longFramesDuringShaderCompile: count(b.longFramesDuringShaderCompile, 1e8),
    firstFrameMs: count(b.firstFrameMs, 3600e3), pipelinesCompiled: count(b.pipelinesCompiled, 1e7),
    storedPipelines: count(b.storedPipelines, 1e7), gpuErrors: count(b.gpuErrors, 1e8),
    thermalS: defined({nominal: count(thermal.nominal, 7 * DAY_S),
                       fair: count(thermal.fair, 7 * DAY_S),
                       serious: count(thermal.serious, 7 * DAY_S),
                       critical: count(thermal.critical, 7 * DAY_S)}),
    lowPowerS: count(b.lowPowerS, 7 * DAY_S),
    guestRefreshCap: oneOf(b.guestRefreshCap, ['capped', 'uncapped', 'mixed']),
    framerateLimit: count(b.framerateLimit, 1000),
    peakFootprintMB: count(b.peakFootprintMB, 1e6), minAvailableMB: count(b.minAvailableMB, 1e6),
    memoryWarnings: count(b.memoryWarnings, 1e6),
  });
}

const MAX_FRAMES = 64;

function crashFrame(f) {
  if (!f || typeof f !== 'object') return null;
  const image = typeof f.image === 'string' ? scrub(f.image.slice(0, 64)) : 'unknown';
  return defined({image, offset: str(f.offset, HEX), symbol: text(f.symbol, 300),
                  binaryUUID: image === 'XeniOS' ? uuid(f.binaryUUID) : undefined});
}

function crashBody(b) {
  const signal = Number.isInteger(b.signal) && b.signal > 0 && b.signal < 64 ? b.signal
                                                                           : str(b.signal, /^SIG[A-Z]{2,8}$|^other$/);
  return defined({
    source: oneOf(b.source, ['app', 'extension', 'metrickit']) ?? 'app',
    type: oneOf(b.type, ['fault', 'fatal', 'exception']), signal,
    exceptionType: count(b.exceptionType, 1e4),
    exceptionCodes: Array.isArray(b.exceptionCodes)
                        ? b.exceptionCodes.slice(0, 4).filter((c) => HEX.test(c)) : undefined,
    faultAddress: str(b.faultAddress, HEX), inJit: typeof b.inJit === 'boolean' ? b.inJit : undefined,
    titleId: str(b.titleId, HEX8), launchId: uuid(b.launchId), binaryUUID: uuid(b.binaryUUID),
    appVersion: str(b.appVersion, SHORT), message: text(b.message, 600),
    terminationReason: text(b.terminationReason, 300),
    frames: Array.isArray(b.frames) ? b.frames.slice(0, MAX_FRAMES).map(crashFrame).filter(Boolean)
                                    : [],
  });
}

// The record as stored, or {error}.
export function cleanEnvelope(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {error: 'not an object'};
  if (e.schema !== 1) return {error: 'unknown schema'};
  if (!KINDS.has(e.kind)) return {error: 'unknown kind'};
  const id = uuid(e.id);
  if (!id) return {error: 'bad id'};
  const build = e.build && typeof e.build === 'object' ? e.build : {};
  if (!str(build.buildId, BUILD_ID)) return {error: 'bad build'};
  const device = e.device && typeof e.device === 'object' ? e.device : {};
  if (!str(device.model, MODEL)) return {error: 'bad device'};
  if (!e.body || typeof e.body !== 'object' || Array.isArray(e.body)) return {error: 'bad body'};
  return {
    schema: 1, kind: e.kind, id,
    build: defined({buildId: build.buildId, channel: str(build.channel, SHORT),
                    appVersion: str(build.appVersion, SHORT),
                    buildNumber: str(build.buildNumber, SHORT),
                    commitShort: str(build.commitShort, /^[0-9a-f]{7,40}$/),
                    stage: str(build.stage, SHORT), binaryUUID: uuid(build.binaryUUID)}),
    device: defined({model: device.model, os: str(device.os, OS)}),
    body: e.kind === 'session' ? sessionBody(e.body) : crashBody(e.body),
  };
}

// Defence in depth behind the client's redaction, for the free text a record
// may carry (a fatal error's message, MetricKit's termination reason, symbol
// names): anything that still looks like a path, a game file name, a quoted
// name, an e-mail or an IP address is replaced. The client's rules
// (ios_diagnostics_outbox.mm xe_ios_diagnostics_redact), and a few more.
const SCRUB_RULES = [
  [/\/(private\/)?var\/(mobile|containers)\/[^\n:]*/gi, '<path>'],
  [/~\/(Documents|Library|tmp)\/[^\n:]*/g, '~/$1/<file>'],
  [/(^|[\s'"(=,])\/[^\s/:'"]+\/[^\n:'"]*/gm, '$1<path>'],
  [/\b[A-Za-z]:\\[^\n:'"]*/g, '<path>'],
  [/file:\/\/[^\s'"]*/gi, '<path>'],
  [/[^\s/\\'"]+\.(iso|xex|xcp|zar|god|stfs|svod)\b/gi, '<file>'],
  [/"[^"\n]*"/g, '"<text>"'],
  [/\u201c[^\u201d\n]*\u201d/g, '\u201c<text>\u201d'],
  [/(^|\s)'[^'\n]+'(?=$|[\s.,;:)])/gm, "$1'<text>'"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>'],
];

export function scrub(value) {
  if (typeof value !== 'string') return value;
  return SCRUB_RULES.reduce((out, [re, replacement]) => out.replace(re, replacement), value);
}

// "iPhone17,1" -> "iPhone17": the chip generation, the grouping for dashboards.
export function deviceClass(model) {
  return String(model ?? '').split(',')[0] || 'unknown';
}

// ---- Session statistics from the frame interval histogram

// The app's bucket edges (ios_session_stats.mm kIntervalEdgesMs). Sessions
// store their counts as columns h0..h12 when they match, so histograms can be
// summed in SQL; the statistics of a group come from its summed histogram.
export const INTERVAL_EDGES_MS = [10, 15, 18.33, 25, 30, 36.67, 45, 55, 60, 73.33, 100, 250];

// What each bucket stands for: a frame time (ms) for statistics and an fps
// label. The guest presents on its 60 Hz vertical blank, so most frames fall
// in the bands around 60, 30, 20 and 15 fps, which stand for exactly those
// rates; a bucket between bands stands for its middle.
export const INTERVAL_BUCKETS = [
  {ms: 1000 / 120, label: '100+'},
  {ms: 12.5, label: '67–100'},
  {ms: 1000 / 60, label: '60'},
  {ms: 21.67, label: '40–55'},
  {ms: 27.5, label: '33–40'},
  {ms: 1000 / 30, label: '30'},
  {ms: 40.83, label: '22–27'},
  {ms: 50, label: '20'},
  {ms: 57.5, label: '17–18'},
  {ms: 1000 / 15, label: '15'},
  {ms: 86.67, label: '10–14'},
  {ms: 175, label: '4–10'},
  {ms: 400, label: 'under 4'},
];

// A session's histogram counts, or null when its edges are not the app's.
export function histogramCounts(body) {
  const edges = body.intervalMs;
  const counts = body.counts;
  if (!Array.isArray(edges) || !Array.isArray(counts) ||
      edges.length !== INTERVAL_EDGES_MS.length || counts.length !== INTERVAL_BUCKETS.length ||
      edges.some((e, i) => Math.abs(e - INTERVAL_EDGES_MS[i]) > 0.005) ||
      !counts.every((c) => Number.isInteger(c) && c >= 0)) {
    return null;
  }
  return counts;
}

// Statistics of a histogram (counts for INTERVAL_BUCKETS): median fps and
// 1 % low fps (the rates the median and 99th percentile frames stand for),
// stutter % (share of time in frames at least 1.5 times the median: a
// dropped frame or worse) and severe frames (over 250 ms).
export function histogramStats(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return {medianFps: null, low1Fps: null, stutterPct: null, severeFrames: 0};
  const at = (q) => {
    let seen = 0;
    for (let i = 0; i < counts.length; ++i) {
      seen += counts[i];
      if (seen >= q * total) return INTERVAL_BUCKETS[i].ms;
    }
    return INTERVAL_BUCKETS.at(-1).ms;
  };
  const median = at(0.5);
  let time = 0;
  let stutterTime = 0;
  counts.forEach((n, i) => {
    const {ms} = INTERVAL_BUCKETS[i];
    time += n * ms;
    if (ms >= 1.5 * median) stutterTime += n * ms;
  });
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    medianFps: round1(1000 / median),
    low1Fps: round1(1000 / at(0.99)),
    stutterPct: round1(100 * stutterTime / time),
    severeFrames: counts.at(-1),
  };
}

// A session record's statistics, or null without a histogram of the app's.
export function sessionStats(body) {
  const counts = histogramCounts(body);
  return counts ? histogramStats(counts) : null;
}

// Session ends that count against crash-free sessions.
export const UNCLEAN_ENDS = new Set(['crash', 'fatal', 'killed']);

// The display setting a session ran with: the guest refresh cap on (the
// default, and what records from before the field say), off, or both.
export function pacingOf(body) {
  return ['capped', 'uncapped', 'mixed'].includes(body.guestRefreshCap) ? body.guestRefreshCap
                                                                        : 'capped';
}

// ---- Game names

// Title ID -> {name, status} for |ids| from the compatibility list's text
// (https://xenios.jp/compatibility/search-index.json, or data.json: each game's
// "title" comes before its "titleId" and "titleIds", its "status" after). A
// scan for each ID rather than a parse of the whole list, which wouldn't fit
// the Workers Free plan's 10 ms of CPU.
export function compatNames(text, ids) {
  const out = new Map();
  for (const id of ids) {
    const key = String(id ?? '').toUpperCase();
    if (!HEX8.test(key) || out.has(key)) continue;
    for (let at = text.indexOf(`"${key}"`); at >= 0; at = text.indexOf(`"${key}"`, at + 1)) {
      // The value of "titleId", or one of "titleIds", not text elsewhere.
      const before = text.slice(Math.max(0, at - 400), at);
      const field = before.lastIndexOf('"titleId');
      if (field < 0 || /[\]}]/.test(before.slice(field))) continue;
      const title = /^"title"\s*:\s*("(?:[^"\\]|\\.)*")/
          .exec(text.slice(Math.max(0, text.lastIndexOf('"title"', at)), at));
      if (!title) continue;
      const status = /"status"\s*:\s*"([a-z-]{1,20})"/.exec(text.slice(at, at + 4000));
      out.set(key, {name: JSON.parse(title[1]).slice(0, 200), status: status?.[1] ?? null});
      break;
    }
  }
  return out;
}

// ---- Symbolication from a make_symbol_map.sh map

export function parseSymbolMap(text) {
  const lines = text.split('\n');
  const header = Object.fromEntries(
      (lines[0].startsWith('#') ? lines.shift().slice(1) : '').split(' ')
          .filter(Boolean).map((kv) => kv.split('=')));
  const addrs = [];
  const names = [];
  for (const line of lines) {
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    addrs.push(BigInt('0x' + line.slice(0, space)));
    names.push(line.slice(space + 1));
  }
  return {uuid: header.uuid, textvmaddr: BigInt(header.textvmaddr ?? '0x100000000'), addrs, names};
}

// A map's rows for D1 (symbol_chunks): |size| symbols each, after the map's
// header line, keyed by the first symbol's offset from the load address.
export function symbolMapChunks(text, size = 512) {
  const lines = text.split('\n');
  const header = lines[0].startsWith('#') ? lines.shift() : '';
  const {uuid, textvmaddr} = parseSymbolMap(header);
  const body = lines.filter((line) => line.indexOf(' ') > 0);
  const chunks = [];
  for (let i = 0; i < body.length; i += size) {
    const part = body.slice(i, i + size);
    const first = BigInt('0x' + part[0].slice(0, part[0].indexOf(' ')));
    chunks.push({start: Number(first - textvmaddr), text: [header, ...part].join('\n')});
  }
  return {uuid, chunks};
}

// One map from some of a map's chunks: it names every offset that falls in
// one of them.
export function mergeSymbolMaps(parts) {
  parts.sort((a, b) => (a.addrs[0] < b.addrs[0] ? -1 : 1));
  return {uuid: parts[0]?.uuid, textvmaddr: parts[0]?.textvmaddr ?? 0x100000000n,
          addrs: parts.flatMap((p) => p.addrs), names: parts.flatMap((p) => p.names)};
}

export async function loadSymbolMap(gzBytes) {
  const stream = new Blob([gzBytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return parseSymbolMap(await new Response(stream).text());
}

// offset: from the image's load address (MetricKit's offsetIntoBinaryTextSegment,
// or a fault record's offset).
export function symbolicate(map, offset) {
  const addr = map.textvmaddr + BigInt(offset);
  let lo = 0;
  let hi = map.addrs.length - 1;
  if (hi < 0 || addr < map.addrs[0]) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.addrs[mid] <= addr) lo = mid; else hi = mid - 1;
  }
  return {name: map.names[lo], delta: Number(addr - map.addrs[lo])};
}

// ---- Crash frames and signatures

// Frames of a crash record: [{image, offset?, symbol?, binaryUUID?}], top of
// stack first (cleanEnvelope checked them).
export function crashFrames(body) {
  return Array.isArray(body.frames) ? body.frames : [];
}

// Fills in the names of XeniOS frames that have none. maps: binaryUUID ->
// parsed symbol map, for the builds that uploaded one.
export function symbolicateFrames(frames, maps, defaultUUID) {
  return frames.map((f) => {
    if (f.symbol || f.image !== 'XeniOS' || !HEX.test(f.offset ?? '')) return f;
    const map = maps.get(f.binaryUUID ?? defaultUUID);
    const found = map ? symbolicate(map, BigInt(f.offset)) : null;
    return found ? {...f, symbol: found.name} : f;
  });
}

// Strips arguments and templates so one function is one signature line.
export function shortName(name) {
  let depth = 0;
  let out = '';
  for (const c of name) {
    if (c === '<' || c === '(') { ++depth; continue; }
    if (c === '>' || c === ')') { --depth; continue; }
    if (depth === 0) out += c;
  }
  // "S::$_1::operator()(int) const" -> "S::$_1::operator()".
  out = out.trim().replace(/\s+(const|volatile|&|&&)$/, '');
  return out.endsWith('::operator') ? `${out}()` : out;
}

// A fatal error's message as a grouping key: its first line, with numbers and
// addresses folded, at most 120 characters.
export function messageKey(message) {
  return String(message).split('\n')[0]
      .replace(/0x[0-9a-f]+|\d+/gi, (m) => (/^0x/i.test(m) ? '0x#' : '#')).trim().slice(0, 120);
}

// The top three frames inside XeniOS: a run of JIT frames collapses to
// "<jit>" and a repeated function (pc and link register) to one line; system
// frames are skipped. Without XeniOS frames, |note| signs instead: a fatal
// error's messageKey(), or the reason MetricKit gives for the termination.
export const MAX_SIGNATURE_CHARS = 300;

export const NO_APP_FRAMES = '<no XeniOS frames>';

export function crashSignature(kind, frames, note = null) {
  const parts = [];
  for (const f of frames) {
    let part = null;
    if (f.image === '<jit>') {
      part = '<jit>';
    } else if (f.image === 'XeniOS') {
      part = f.symbol ? shortName(f.symbol) : `XeniOS+${f.offset}`;
    }
    if (part && parts.at(-1) !== part) parts.push(part);
    if (parts.length === 3) break;
  }
  const signature = !parts.length && note ? `${kind}: ${note}`
                                          : `${kind}: ${parts.join(' < ') || NO_APP_FRAMES}`;
  return signature.slice(0, MAX_SIGNATURE_CHARS);
}

// Darwin signal numbers: the app sends names, the crash reporter extension
// and MetricKit numbers; one crash must sign the same from all three.
const SIGNALS = {4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGEMT', 8: 'SIGFPE', 9: 'SIGKILL',
                 10: 'SIGBUS', 11: 'SIGSEGV', 12: 'SIGSYS', 13: 'SIGPIPE'};

// The first part of a signature: the signal, the exception type or "fatal".
export function crashKind(body) {
  if (body.type === 'fatal') return 'fatal';
  if (body.signal !== undefined) return SIGNALS[Number(body.signal)] ?? String(body.signal);
  if (body.exceptionType !== undefined) return `exception ${body.exceptionType}`;
  return 'crash';
}

// When one launch is reported more than once the richer report counts: the
// extension (every frame symbolicated on the device), then the app's own
// record, then MetricKit (which often blames the main thread).
export const SOURCE_RANK = {extension: 0, app: 1, metrickit: 2};

// ---- Triage issues (private GitHub repo)

export function issueDraft(group) {
  const list = (json) => JSON.parse(json ?? '[]').join(', ') || '-';
  return {
    title: `Crash: ${group.signature}`.slice(0, 250),
    body: [
      `**${group.count}** reports, first ${group.first_day}, last ${group.last_day}.`,
      '',
      `- Builds: ${list(group.builds)}`,
      `- Titles: ${list(group.titles)}`,
      `- Devices: ${list(group.models)}`,
      '',
      'Updated by the XeniOS diagnostics Worker. Counts are official builds only.',
    ].join('\n'),
  };
}
