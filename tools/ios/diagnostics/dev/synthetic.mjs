// Fills an empty DATA_DIR with a synthetic month of records, to try the
// dashboard with something in it:
//   node dev/synthetic.mjs DATA_DIR [SYMBOL_MAP.map.gz]
//   DASHBOARD_LABEL="Synthetic data" node dev/server.mjs DATA_DIR
// None of it comes from players. Builds, devices, play time, frame pacing,
// startup, shader caches, GPU errors and crashes are made up (seeded, so every
// run is the same) and go through ingest() and the cron like real records. Game names need
// DATA_DIR/compat-data.json; with a symbol map from tools/ios/make_symbol_map.sh
// the crash frames point at real functions of that build and symbolicate.

import {existsSync, readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import {ingest, rollUpDay} from '../worker/index.mjs';
import {INTERVAL_EDGES_MS, dayOffset, parseSymbolMap, shortName} from '../worker/lib.mjs';
import {localEnv, runCronUntilSigned} from './local.mjs';
import {storeSymbolMap} from '../symbols.mjs';

const [dataDir, mapPath] = process.argv.slice(2);
if (!dataDir) {
  console.error('usage: node dev/synthetic.mjs DATA_DIR [SYMBOL_MAP.map.gz]');
  process.exit(2);
}
if (existsSync(join(dataDir, 'd1.sqlite'))) {
  console.error(`${dataDir} already has data; give an empty directory`);
  process.exit(2);
}
const KEY = 'synthetic-attestation-key';
const env = localEnv(dataDir, {ATTESTATION_KEY: KEY});
const DAYS = 30;
const today = new Date().toISOString().slice(0, 10);

// ---- Seeded randomness

let seed = 20261103;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + (b - a) * rand();
const chance = (p) => rand() < p;
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
function pick(weighted) {
  let x = rand() * weighted.reduce((a, [, w]) => a + w, 0);
  for (const [value, w] of weighted) {
    if ((x -= w) < 0) return value;
  }
  return weighted.at(-1)[0];
}
const hex = (n) => Array.from({length: n}, () => '0123456789ABCDEF'[Math.floor(rand() * 16)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-A${hex(3)}-${hex(12)}`;

// ---- The made-up world

// A new release ten days ago fixes a draw crash and brings a JIT one.
const BUILDS = {
  old: {id: 'ios-release-2.1.0-11180', official: true},
  new: {id: 'ios-release-2.1.1-11246', official: true},
  self: {id: 'ios-self-built-2-1-11252', official: false},
};
// model: [weight, speed, heat, memory pressure]
const DEVICES = {
  'iPhone18,1': [8, 1.2, 0.8, 0.6], 'iPhone18,2': [6, 1.2, 0.7, 0.6],
  'iPhone17,1': [16, 1.0, 1.0, 1.0], 'iPhone17,2': [12, 1.0, 0.9, 1.0], 'iPhone17,3': [9, 0.95, 1.1, 1.3],
  'iPhone16,1': [9, 0.85, 1.2, 1.6], 'iPhone16,2': [7, 0.85, 1.1, 1.6], 'iPhone15,2': [5, 0.68, 1.4, 3.0],
  'iPad17,3': [5, 1.3, 0.4, 0.4], 'iPad16,3': [6, 1.15, 0.5, 0.5], 'iPad14,5': [4, 0.8, 0.6, 1.4],
};
const OSES = [['26.4', 8], ['26.5', 22], ['27.0', 32], ['27.1', 38]];
// titleId: [weight, target fps, demand, crashiness, footprint MB, compile hitchiness]
// (startup seconds and stored pipelines scale with demand and hitchiness)
const GAMES = {
  '4D5307E6': [20, 30, 0.9, 1.0, 3300, 1.6],   // Halo 3
  '4D53085B': [14, 30, 1.05, 0.9, 3600, 1.2],  // Halo: Reach
  '4D53082D': [12, 30, 1.0, 1.3, 3500, 1.0],   // Gears of War 2
  '454109BA': [9, 30, 1.4, 1.8, 4300, 1.4],    // Battlefield 4
  '415607E6': [9, 60, 1.0, 0.8, 3100, 0.8],    // Call of Duty 4: Modern Warfare
  '53450848': [8, 60, 0.85, 0.6, 2900, 0.7],   // Sonic Generations
  '454108E6': [8, 30, 0.75, 0.5, 2800, 0.5],   // Skate 3
  '454108D4': [7, 30, 0.8, 0.7, 3000, 0.9],    // Left 4 Dead 2
  '4D5309C9': [6, 30, 1.25, 1.1, 4000, 1.3],   // Forza Horizon
  '465307E4': [5, 30, 1.2, 1.0, 3700, 1.1],    // Dark Souls 2
  '4D5307FA': [3, 30, 1.1, 0.9, 3400, 0.8],    // Lost Odyssey
  '45410806': [3, 60, 1.15, 1.2, 3600, 0.9],   // Burnout Paradise
};

// Crash groups: frames as [function (as shortName gives it), offset into it], top first.
const CRASHES = {
  jit: {signal: 'SIGSEGV', jit: true, frames: [['xe::cpu::Processor::Execute', 0x5c],
                                             ['xe::kernel::XThread::Execute', 0x88]]},
  draw: {signal: 'SIGSEGV', frames: [['xe::gpu::metal::MetalCommandProcessor::IssueDrawMsl', 0x5c],
                                     ['xe::gpu::metal::MetalCommandProcessor::IssueDraw', 0x40],
                                     ['xe::gpu::CommandProcessor::ExecutePacket', 0x30]]},
  texture: {signal: 'SIGBUS', frames: [['xe::gpu::metal::MetalTextureCache::TryGpuLoadTexture::$_4::operator()', 0x48],
                                       ['xe::gpu::CommandProcessor::ExecutePacket', 0x30]]},
  reserved: {signal: 'SIGSEGV', frames: [['xe::cpu::backend::a64::A64Backend::ReservedLoad32', 0x24]],
             jitBelow: true},
  content: {signal: 'SIGSEGV', frames: [['xe::kernel::xam::ContentPackage::ContentPackage', 0x38],
                                        ['xe::kernel::xam::ContentManager::OpenContent', 0x6c]]},
};
const FATAL_MESSAGES = [
  'Unable to reserve the guest address space: not enough memory is free.',
  'Failed to create the Metal device.',
];

// ---- Symbol map: offsets of the named functions, and the build's UUID

let map = null;
const offsets = new Map();
if (mapPath) {
  map = parseSymbolMap(gunzipSync(readFileSync(mapPath)).toString('utf8'));
  const wanted = new Set(Object.values(CRASHES).flatMap((g) => g.frames.map(([name]) => name)));
  map.names.forEach((n, i) => {
    const name = shortName(n);
    if (wanted.has(name) && !offsets.has(name)) offsets.set(name, map.addrs[i] - map.textvmaddr);
  });
  await storeSymbolMap(env, readFileSync(mapPath));
}
const binaryUUID = map?.uuid ?? 'C04E6678-6BB2-36C0-BBAB-728B36AF435F';
const fallback = new Map(Object.values(CRASHES).flatMap((g) => g.frames)
    .map(([name], i) => [name, BigInt(0x200000 + i * 0x4000)]));

function stack(group) {
  const out = [];
  if (group.jit) out.push({image: '<jit>', offset: `0x${hex(5).toLowerCase()}`});
  for (const [name, delta] of group.frames) {
    const base = offsets.get(name) ?? fallback.get(name);
    out.push({image: 'XeniOS', offset: `0x${(base + BigInt(delta)).toString(16)}`});
  }
  if (group.jitBelow) out.push({image: '<jit>', offset: `0x${hex(5).toLowerCase()}`});
  out.push({image: 'system'}, {image: 'system'});
  return out;
}

// ---- Records

function attestation(buildId) {
  const payload = `xenios-build-attestation-v1;platform=ios;channel=release;buildId=${buildId}`;
  const signature = createHmac('sha256', KEY).update(payload).digest('base64')
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return {payload, signature};
}

function envelope(kind, build, model, os, body) {
  return {
    schema: 1, kind, id: uuid(),
    build: {buildId: build.id, channel: build.official ? 'release' : 'self-built', binaryUUID,
            ...(build.official ? {attestation: attestation(build.id)} : {})},
    device: {model, os},
    body,
  };
}

const bucket = (ms) => {
  let i = 0;
  while (i < INTERVAL_EDGES_MS.length && ms > INTERVAL_EDGES_MS[i]) ++i;
  return i;
};

// Capped play presents on the 60 Hz vertical blank: frames take a whole
// number of blanks (16.67 ms each) and jitter a little; a frame that misses
// its blank takes one more. Uncapped play runs at whatever rate it reaches.
function histogram({fps, target, performance, frames, stutter, hitches, capped}) {
  const counts = new Array(INTERVAL_EDGES_MS.length + 1).fill(0);
  const stutterFrames = Math.round(frames * stutter);
  const body = Math.max(0, frames - stutterFrames - hitches);
  if (capped) {
    const blanks = Math.round(60 / target);
    const late = Math.min(0.6, Math.max(0, 1 - performance) * 1.6);
    for (const [k, w] of [[blanks, 1 - late], [blanks + 1, late]]) {
      for (const [jitter, share] of [[-1.1, 0.25], [0, 0.5], [1.2, 0.25]]) {
        counts[bucket(k * 1000 / 60 + jitter)] += Math.round(body * w * share);
      }
    }
    counts[bucket((blanks * 2 + 1) * 1000 / 60)] += stutterFrames;
  } else {
    const frameMs = 1000 / fps;
    for (const [k, w] of [[0.8, 0.25], [1, 0.45], [1.25, 0.3]]) {
      counts[bucket(frameMs * k)] += Math.round(body * w);
    }
    counts[bucket(frameMs * 2.2)] += stutterFrames;
  }
  for (const [ms, w] of [[58, 0.46], [80, 0.3], [160, 0.19], [400, 0.05]]) {
    counts[bucket(ms)] += Math.round(hitches * w);
  }
  return counts;
}

async function post(record, day) {
  const text = JSON.stringify(record);
  const response = await ingest(new Request('http://localhost/v1/diag', {
    method: 'POST', body: text,
    headers: {'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text))}}),
    env, new Date(`${day}T12:00:00Z`));
  if (response.status !== 204) throw new Error(`${response.status} ${await response.text()}`);
}

let sessions = 0;
let crashes = 0;
for (let ago = DAYS - 1; ago >= 0; --ago) {
  const day = dayOffset(today, -ago);
  const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  const count = Math.round((weekend ? 170 : 125) * (1 + (DAYS - ago) / 90) * between(0.88, 1.12));
  // The new release reaches most players within a week of coming out.
  const adoption = ago > 9 ? 0 : Math.min(0.86, (10 - ago) * 0.13);
  for (let n = 0; n < count; ++n) {
    const build = chance(0.035) && ago < 7 ? BUILDS.self : chance(adoption) ? BUILDS.new : BUILDS.old;
    const isNew = build !== BUILDS.old;
    const model = pick(Object.entries(DEVICES).map(([m, [w]]) => [m, w]));
    const [, speed, heat, memory] = DEVICES[model];
    const os = pick(OSES);
    const titleId = pick(Object.entries(GAMES).map(([t, [w]]) => [t, w]));
    const [, target, demand, crashiness, footprint, compiling] = GAMES[titleId];
    const launchId = uuid();
    // A first run of a game compiles every pipeline: slower start, more hitches.
    const cold = chance(0.13);
    const stored = cold ? 0 : Math.round(1800 * compiling * demand * between(0.6, 1.6));
    const firstFrameMs = Math.round(1000 * (6 + 9 * demand) * (cold ? 1.35 : 1) / speed *
                                    Math.exp(0.18 * gauss()));

    const durationS = Math.round(Math.min(4 * 3600, Math.max(60, Math.exp(7.2 + 0.85 * gauss()))));
    const activeS = Math.round(durationS * between(0.88, 0.99));
    const capped = !chance(0.07);
    const mixed = !capped && chance(0.2);
    const limit = chance(0.08) ? pick([[30, 3], [60, 1]]) : 0;
    const performance = (speed / demand) * Math.exp(0.07 * gauss());
    let fps = capped ? target * Math.min(1, performance) : target * performance * 1.7;
    if (limit) fps = Math.min(fps, limit);
    const frames = Math.round(activeS * fps);
    const stutter = Math.min(0.2, Math.max(0.002, (0.018 + Math.max(0, 1 - performance) * 0.12) *
                                                    Math.exp(0.4 * gauss()) * (capped ? 1 : 2.2)));
    const hitchRate = Math.max(0.05, (0.6 + compiling * (isNew ? 0.55 : 1.1)) * (cold ? 2.6 : 1) *
                                     (titleId === '4D5307E6' && isNew ? 0.55 : 1) * Math.exp(0.5 * gauss()));
    const compiled = (cold ? Math.round(2600 * compiling * demand) : stored) +
                     Math.round(between(10, 260) * compiling * (isNew ? 0.6 : 1));
    // GPU faults: rare, but Forza Horizon on A16 phones hits one often.
    const gpuP = titleId === '4D5309C9' && model === 'iPhone15,2' ? 0.22 : 0.008;
    const gpuErrors = chance(gpuP) ? Math.round(between(1, 40)) : 0;
    const hitches = Math.round((hitchRate * activeS) / 60);
    const compileShare = Math.min(0.92, 0.25 + 0.35 * compiling * (isNew ? 0.7 : 1) + 0.08 * gauss());

    const hot = Math.min(0.6, Math.max(0, 0.06 * heat * demand * (durationS / 2400) + 0.03 * gauss()));
    const critical = hot * between(0, 0.12);
    const fair = Math.min(1 - hot, between(0.15, 0.4));
    const thermalS = {
      nominal: Math.round(durationS * (1 - hot - fair)), fair: Math.round(durationS * fair),
      serious: Math.round(durationS * (hot - critical)), critical: Math.round(durationS * critical),
    };

    const peak = Math.round(footprint * between(0.9, 1.12) * (memory > 2 ? 0.92 : 1));
    const killedP = 0.0035 * memory * (footprint / 3400) ** 3 * (durationS / 2400);
    const crashP = 0.011 * crashiness * (isNew ? 0.8 : 1.15);
    let end = pick([['normal', 70], ['background', 22], ['terminated', 8]]);
    let crash = null;
    if (chance(killedP)) {
      end = 'killed';
    } else if (chance(0.0018)) {
      end = 'fatal';
    } else if (chance(crashP)) {
      end = 'crash';
      const groups = [['jit', 5], ['texture', 1.5]];
      groups.push(isNew ? ['reserved', ['4D53082D', '4D53085B'].includes(titleId) ? 16 : 4]
                        : ['draw', ['454109BA', '4D5309C9'].includes(titleId) ? 9 : 2.5]);
      if (titleId === '454108E6') groups.push(['content', 6]);
      crash = pick(groups);
    }

    const counts = histogram({fps, target: limit ? Math.min(target, limit) : target, performance,
                              frames, stutter, hitches, capped});
    await post(envelope('session', build, model, os, {
      titleId, durationS, activeS, frames: counts.reduce((a, b) => a + b, 0), firstFrameMs,
      intervalMs: INTERVAL_EDGES_MS, counts, gaps: Math.round(between(0, 4)),
      longFrames: hitches, longFramesDuringShaderCompile: Math.round(hitches * Math.max(0, compileShare)),
      pipelinesCompiled: compiled, storedPipelines: stored, gpuErrors,
      thermalS, lowPowerS: chance(0.06) ? Math.round(durationS * between(0.2, 1)) : 0,
      guestRefreshCap: mixed ? 'mixed' : capped ? 'capped' : 'uncapped', framerateLimit: limit,
      peakFootprintMB: peak, minAvailableMB: Math.round(Math.max(60, between(250, 1400) / memory)),
      memoryWarnings: chance(0.05 * memory) ? Math.round(between(1, 4)) : 0, end,
    }), day);
    ++sessions;

    const reportDay = ago > 0 && chance(0.3) ? dayOffset(day, 1) : day;
    const nextDay = ago > 0 ? dayOffset(day, 1) : day;
    if (end === 'killed' && chance(0.3)) {
      // Not the memory limit (which MetricKit doesn't report) but the
      // watchdog: MetricKit says so a launch later.
      await post(envelope('crash', build, model, os, {
        source: 'metrickit', type: 'exception', signal: 9, exceptionType: 10, launchId, titleId,
        terminationReason: 'Namespace FRONTBOARD, Code 0x8badf00d',
        frames: [{image: 'libsystem_kernel.dylib', offset: '0xcd4'},
                 {image: 'CoreFoundation', offset: '0x3b40c'}]}), nextDay);
      ++crashes;
    }
    if (end === 'fatal') {
      await post(envelope('crash', build, model, os, {
        source: 'app', type: 'fatal', launchId, titleId, message: pick(FATAL_MESSAGES.map((m) => [m, 1])),
        frames: []}), reportDay);
      ++crashes;
    } else if (crash) {
      const group = CRASHES[crash];
      const iOS27 = os.startsWith('27');
      const fromExtension = iOS27 && chance(0.85);
      const body = {type: 'fault', launchId, titleId, binaryUUID, frames: stack(group),
                    faultAddress: group.signal === 'SIGBUS' ? `0x1${hex(8).toLowerCase()}` : '0x0'};
      // On iOS 27 the extension reports at once and the app again at the next
      // launch; the cron keeps the extension's.
      if (fromExtension) {
        await post(envelope('crash', build, model, os, {...body, source: 'extension',
          signal: group.signal === 'SIGBUS' ? 10 : 11}), day);
      }
      if (!fromExtension || chance(0.6)) {
        await post(envelope('crash', build, model, os, {...body, source: 'app', signal: group.signal}),
                   reportDay);
      }
      ++crashes;
      // MetricKit reports the same launch a launch later; the cron counts the
      // richer report.
      if (chance(0.25)) {
        await post(envelope('crash', build, model, os, {
          source: 'metrickit', type: 'exception', signal: group.signal === 'SIGBUS' ? 10 : 11,
          exceptionType: 1, launchId, titleId,
          frames: stack(group).filter((f) => f.image === 'XeniOS').map((f) => ({...f, binaryUUID}))}),
                   nextDay);
      }
    }
  }
}

await runCronUntilSigned(env, dataDir);
for (let ago = DAYS; ago >= 0; --ago) await rollUpDay(env, dayOffset(today, -ago));
console.log(`synthetic: ${sessions} sessions, ${crashes} crashes over ${DAYS} days` +
            (map ? `, frames from ${map.uuid}` : ''));
