// node --test test/  (from tools/ios/diagnostics)
// XENIOS_SYMBOL_MAP=<UUID>.map.gz and XENIOS_BINARY=<path to XeniOS> add a
// symbolication check against atos on a real build.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {verifyAttestation, cleanEnvelope, scrub, loadSymbolMap, symbolicate, shortName,
        crashSignature, sessionStats, deviceClass, mergeSymbolMaps, parseSymbolMap,
        symbolMapChunks, INTERVAL_EDGES_MS} from '../worker/lib.mjs';
import {KEY, sign} from './helpers.mjs';

function envelope(overrides = {}) {
  return {
    schema: 1, kind: 'session', id: randomUUID(),
    build: {buildId: 'ios-release-2.2.0-9901', channel: 'release'},
    device: {model: 'iPhone17,1', os: '27.1'},
    body: {titleId: '4D5307E6', durationS: 1800},
    ...overrides,
  };
}

test('attestation matches the release script HMAC and names the build', async () => {
  const payload = 'xenios-build-attestation-v1;platform=ios;channel=release;buildId=x';
  assert.equal(await verifyAttestation(payload, sign(payload), KEY), true);
  assert.equal(await verifyAttestation(payload, sign(payload), KEY, 'x'), true);
  assert.equal(await verifyAttestation(payload, sign(payload), KEY, 'y'), false,
               'an attestation copied from another build');
  assert.equal(await verifyAttestation(payload, sign(payload, 'other'), KEY), false);
  assert.equal(await verifyAttestation('not-an-attestation', sign('x'), KEY), false);
  assert.equal(await verifyAttestation(payload, sign(payload), ''), false);
});

test('envelope checks', () => {
  assert.equal(cleanEnvelope(envelope()).error, undefined);
  assert.equal(cleanEnvelope(envelope({kind: 'mx-metric'})).error, 'unknown kind');
  assert.equal(cleanEnvelope(envelope({device: {model: 'Bob\'s iPhone'}})).error, 'bad device');
  assert.equal(cleanEnvelope(envelope({device: {model: ['iPhone1,1']}})).error, 'bad device');
  assert.equal(cleanEnvelope(envelope({build: {buildId: 'a b'}})).error, 'bad build');
  assert.equal(cleanEnvelope(envelope({body: []})).error, 'bad body');
  assert.equal(cleanEnvelope(envelope({id: 'x'})).error, 'bad id');
  const id = randomUUID().toLowerCase();
  assert.equal(cleanEnvelope(envelope({id})).id, id.toUpperCase(), 'one id, whatever its case');
});

test('records keep only known fields, checked', () => {
  const session = cleanEnvelope(envelope({
    createdAt: '2026-11-03T08:00:00Z',
    build: {buildId: 'ios-release-2.2.0-9901', channel: 'release', secret: 'x',
            attestation: {payload: 'p', signature: 's'}},
    device: {model: 'iPhone17,1', os: {a: 1}, lowPower: true, name: 'Kenji\'s iPhone'},
    body: {titleId: ['4D5307E6'], durationS: 6e18, activeS: -5, frames: 1000, cpuS: 9,
           launchId: randomUUID(), end: 'normal', thermalS: {nominal: 60, hot: 1},
           counts: [1, -1], intervalMs: [10], extra: 'anything', firstFrameMs: 8000},
  }));
  assert.deepEqual(Object.keys(session).sort(), ['body', 'build', 'device', 'id', 'kind', 'schema']);
  assert.deepEqual(session.build, {buildId: 'ios-release-2.2.0-9901', channel: 'release'});
  assert.deepEqual(session.device, {model: 'iPhone17,1'});
  assert.deepEqual(session.body, {end: 'normal', frames: 1000, intervalMs: [10],
                                  thermalS: {nominal: 60}, firstFrameMs: 8000});
  const crash = cleanEnvelope(envelope({kind: 'crash', body: {
    source: 'elsewhere', type: 'fault', signal: '11; DROP TABLE', faultAddress: '0x0',
    message: 'Could not open /Users/kenji/Games/Halo 3/default.xex: denied',
    frames: [...Array(100)].map((_, i) => ({image: 'XeniOS', offset: i ? `0x${i}` : 'zz',
                                            binaryUUID: randomUUID(), pid: 1})),
  }})).body;
  assert.equal(crash.source, 'app');
  assert.equal(crash.signal, undefined);
  assert.equal(crash.message, 'Could not open <path>: denied');
  assert.equal(crash.frames.length, 64);
  assert.equal(crash.frames[0].offset, undefined, 'a bad offset is dropped');
  assert.deepEqual(Object.keys(crash.frames[1]).sort(), ['binaryUUID', 'image', 'offset']);
});

test('scrub removes paths, names, e-mail and addresses', () => {
  const cases = [
    ['mapped file /private/var/containers/Bundle/Application/1234/XeniOS.app/XeniOS',
     'mapped file <path>'],
    ['Failed to open ~/Documents/Kenji Halo rip.iso: denied', 'Failed to open ~/Documents/<file>: denied'],
    ['/Users/alice/Library/Foo.xex', '<path>'],
    ['loading C:\\Users\\bob\\x.iso', 'loading <path>'],
    ['open /Volumes/USB/game: no', 'open <path>: no'],
    ['Failed to open Gears2.iso', 'Failed to open <file>'],
    ['Profile "Kenji" missing, can\'t sign in', 'Profile "<text>" missing, can\'t sign in'],
    ["Title 'Halo 3' failed", "Title '<text>' failed"],
    ['mail me at someone@example.com', 'mail me at <email>'],
    ['peer 192.168.1.20 refused', 'peer <ip> refused'],
    ['xe::kernel::XThread::Execute()', 'xe::kernel::XThread::Execute()'],
    ['Namespace FRONTBOARD, Code 0x8badf00d', 'Namespace FRONTBOARD, Code 0x8badf00d'],
  ];
  for (const [input, output] of cases) assert.equal(scrub(input), output, input);
});

test('session statistics from the frame histogram', () => {
  const intervalMs = INTERVAL_EDGES_MS;
  // A steady 30 fps game: its frames in the 30 fps band, some at 20, a few
  // long ones.
  const s = sessionStats({intervalMs, counts: [0, 0, 10, 20, 50, 9000, 300, 400, 30, 100, 20, 10, 5]});
  assert.equal(s.medianFps, 30);
  assert.equal(s.low1Fps, 15, `1% low ${s.low1Fps}`);
  assert.ok(s.stutterPct > 5 && s.stutterPct < 10, `stutter ${s.stutterPct}`);
  assert.equal(s.severeFrames, 5);
  // Locked at 60: median and 1 % low both 60.
  const locked = sessionStats({intervalMs, counts: [0, 0, 5000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]});
  assert.deepEqual([locked.medianFps, locked.low1Fps, locked.stutterPct], [60, 60, 0]);
  assert.equal(sessionStats({intervalMs, counts: [1, 2]}), null);
  assert.equal(sessionStats({intervalMs: [8.3, 16.7], counts: [1, 2, 3]}), null,
               'old bucket edges are not read');
  assert.equal(sessionStats({intervalMs, counts: new Array(13).fill(0)}).medianFps, null);
  assert.equal(deviceClass('iPad16,3'), 'iPad16');
});

test('signatures: JIT runs, repeated functions, system frames and notes', () => {
  assert.equal(shortName('xe::cpu::Processor::Execute(xe::cpu::ThreadState*, unsigned int)'),
               'xe::cpu::Processor::Execute');
  assert.equal(shortName('xe::gpu::T::Load(int)::$_1::operator()(unsigned int) const'),
               'xe::gpu::T::Load::$_1::operator()');
  const sig = crashSignature('SIGSEGV', [
    {image: '<jit>', offset: '0x10'}, {image: '<jit>', offset: '0x20'},
    {image: 'libsystem_kernel.dylib', symbol: '__pthread_kill'},
    {image: 'XeniOS', offset: '0x100', symbol: 'xe::kernel::XThread::Execute()'},
    {image: 'XeniOS', offset: '0x104', symbol: 'xe::kernel::XThread::Execute()'},
    {image: 'XeniOS', offset: '0x1234'},
  ]);
  assert.equal(sig, 'SIGSEGV: <jit> < xe::kernel::XThread::Execute < XeniOS+0x1234');
  assert.equal(crashSignature('fatal', [{image: 'system'}]), 'fatal: <no XeniOS frames>');
  assert.equal(crashSignature('SIGKILL', [{image: 'CoreFoundation'}],
                              'Namespace FRONTBOARD, Code 0x8badf00d'),
               'SIGKILL: Namespace FRONTBOARD, Code 0x8badf00d');
  assert.ok(crashSignature('SIGSEGV', [], 'x'.repeat(1000)).length <= 300);
});

test('a map in chunks names what the whole map names', () => {
  const lines = ['#uuid=C04E6678-6BB2-36C0-BBAB-728B36AF435F textvmaddr=0x100000000'];
  for (let i = 0; i < 1000; ++i) lines.push(`${(0x100004000 + i * 0x40 + (i % 7) * 4).toString(16)} f${i}()`);
  const text = lines.join('\n');
  const whole = parseSymbolMap(text);
  const {uuid, chunks} = symbolMapChunks(text, 128);
  assert.equal(uuid, 'C04E6678-6BB2-36C0-BBAB-728B36AF435F');
  assert.equal(chunks.length, 8);
  assert.equal(chunks[0].start, 0x4000);
  const parts = chunks.map((c) => ({start: c.start, map: parseSymbolMap(c.text)}));
  // Each offset with only the chunk it falls in (the last that starts at or
  // before it), as the Worker fetches them; chunk edges included.
  const offsets = [0x4000, 0x4004, 0x4000 + 127 * 0x40 + 30, 0x4000 + 128 * 0x40 + 8, 0x4000 + 999 * 0x40 + 400];
  for (const offset of offsets) {
    const part = parts.filter((p) => p.start <= offset).at(-1);
    const merged = mergeSymbolMaps([parts[5].map, part.map].filter((m, i, a) => a.indexOf(m) === i));
    assert.deepEqual(symbolicate(merged, BigInt(offset)), symbolicate(whole, BigInt(offset)), `0x${offset.toString(16)}`);
  }
  assert.equal(symbolicate(mergeSymbolMaps([parts[0].map]), 0x100n), null, 'before the first symbol');
});

const mapPath = process.env.XENIOS_SYMBOL_MAP;
const binary = process.env.XENIOS_BINARY;
test('symbolication agrees with atos on a real build',
     {skip: !(mapPath && binary && existsSync(mapPath) && existsSync(binary))}, async () => {
  const map = await loadSymbolMap(readFileSync(mapPath));
  assert.ok(map.addrs.length > 10000, 'map has the function symbols');
  // A deterministic spread of functions, each probed a few bytes in.
  const picks = [];
  for (let i = 1; i <= 12; ++i) {
    const index = Math.floor((map.addrs.length - 2) * i / 13);
    const inside = map.addrs[index + 1] - map.addrs[index] > 8n ? 4n : 0n;
    picks.push(map.addrs[index] + inside);
  }
  const hex = picks.map((a) => '0x' + a.toString(16));
  const atos = execFileSync('atos', ['-o', binary, '-arch', 'arm64', '-l',
                                     '0x' + map.textvmaddr.toString(16), ...hex],
                            {encoding: 'utf8'}).trim().split('\n');
  let agree = 0;
  for (let i = 0; i < picks.length; ++i) {
    const ours = symbolicate(map, picks[i] - map.textvmaddr);
    // atos prints "name (in XeniOS) + delta"; compare the name part.
    const theirs = atos[i].replace(/ \(in [^)]*\).*$/, '');
    if (ours && ours.name === theirs) ++agree;
    else console.log(`mismatch at ${hex[i]}: ours=${ours?.name} atos=${theirs}`);
  }
  console.log(`symbolication: ${agree}/${picks.length} frames match atos`);
  assert.ok(agree >= picks.length - 1);
});
