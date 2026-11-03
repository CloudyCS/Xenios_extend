// Local test: mock TURN server + `wrangler dev`. Never talks to a Cloudflare account.
// Not covered: the 60-second silence drop (too slow).
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

// ---- mock Cloudflare: TURN credentials, their revocation, and TURN usage ----
let turnMode = "array"; // array | object | fail
const turnCalls = []; // credential requests
let turnSerial = 0;
const revoked = [];
let usageMode = "ok"; // ok | fail | errors
let usageBytes = 0;
const usageCalls = [];
const iceServers = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
  {
    urls: [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:53?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turn:turn.cloudflare.com:80?transport=tcp",
      "turn:turn2.example.com:3478",
    ],
    username: "user1", // replaced by a new one per request
    credential: "cred1",
  },
];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const revoke = /^\/v1\/turn\/keys\/testkey\/credentials\/([^/]+)\/revoke$/.exec(req.url);
    if (revoke && req.method === "POST" && req.headers.authorization === "Bearer testtoken") {
      revoked.push(decodeURIComponent(revoke[1]));
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/graphql") {
      usageCalls.push({ auth: req.headers.authorization, body });
      if (usageMode === "fail") return void res.writeHead(500).end("nope");
      const payload = usageMode === "errors"
        ? { data: null, errors: [{ message: "not authorized" }] }
        : { data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: usageBytes } }] }] } }, errors: null };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    turnCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (turnMode === "fail") {
      res.writeHead(500).end("nope");
      return;
    }
    const username = "user" + ++turnSerial;
    const servers = iceServers.map((s) => (s.username ? { ...s, username } : s));
    const payload = turnMode === "object" ? { iceServers: servers[1] } : { iceServers: servers };
    res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  });
});

// ---- ws client helper ----
let base, wsBase;
class Client {
  // ip: the address the lobby sees, as Cloudflare would put it in CF-Connecting-IP.
  constructor(p, ip) {
    this.msgs = [];
    this.waiters = [];
    this.closeInfo = null;
    this.closeWaiters = [];
    this.ws = new WebSocket(wsBase + p, ip ? { headers: { "CF-Connecting-IP": ip } } : undefined);
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("ws error"));
    });
    this.ws.onmessage = (e) => {
      const m = e.data;
      this.msgs.push(m);
      this.waiters.shift()?.();
    };
    this.ws.onclose = (e) => {
      this.closeInfo = { code: e.code };
      this.waiters.splice(0).forEach((w) => w());
      this.closeWaiters.splice(0).forEach((w) => w());
    };
  }
  async next(ms = 5000) {
    const deadline = Date.now() + ms;
    while (!this.msgs.length) {
      if (this.closeInfo) throw new Error("closed while waiting, code " + this.closeInfo.code);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout waiting for message");
      await new Promise((res) => {
        const t = setTimeout(res, left);
        this.waiters.push(() => (clearTimeout(t), res()));
      });
    }
    const m = this.msgs.shift();
    return m === "pong" ? m : JSON.parse(m);
  }
  async closed(ms = 5000) {
    if (!this.closeInfo) {
      await Promise.race([
        new Promise((r) => this.closeWaiters.push(r)),
        new Promise((r) => setTimeout(r, ms)),
      ]);
    }
    assert.ok(this.closeInfo, "socket did not close");
    return this.closeInfo.code;
  }
  send(o) {
    this.ws.send(typeof o === "string" ? o : JSON.stringify(o));
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

const clients = [];
// Each test connects from its own address unless it says otherwise, so the TURN per-address limit
// doesn't carry over between tests.
let testIp = "";
async function connect(p, ip = testIp) {
  const c = new Client(p, ip);
  clients.push(c);
  await c.opened;
  return c;
}

const mac = (n) => "001dd801" + n.toString(16).padStart(4, "0");
const join = (n, o = {}) => ({
  t: "join", v: 1, mac: mac(n), title: "4D5307E6", version: 123,
  candidates: [`192.168.1.${n % 250}:40000`], ...o,
});
let roomN = 0;
const privRoom = () => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = ++roomN, s = "";
  for (let i = 0; i < 6; i++) { s = A[n % 32] + s; n = Math.floor(n / 32); }
  return "/v1/room/" + s;
};

// A title no earlier run has a lobby for (the test state persists between runs).
const freshTitle = () => "E" + randomBytes(4).toString("hex").slice(0, 7).toUpperCase();

async function online() {
  const r = await fetch(base + "/v1/online");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/json/);
  const body = await r.json();
  assert.equal(body.v, 1);
  return body.titles;
}

// Waits for the directory to list |n| players for |title| (0: not listed).
async function expectOnline(title, n, ms = 3000) {
  const deadline = Date.now() + ms;
  let titles;
  for (;;) {
    titles = await online();
    if ((titles[title] ?? 0) === n) break;
    if (Date.now() > deadline) assert.fail(`${title}: expected ${n} players, directory has ${JSON.stringify(titles)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(title in titles, n > 0);
}

async function expectReject(c, reason, code, ms = 5000) {
  const m = await c.next(ms);
  assert.deepEqual(m, { t: "reject", reason });
  assert.equal(await c.closed(), code);
}

// ---- tests ----
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("health", async () => {
  const r = await fetch(base + "/v1/health");
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), "ok");
});

test("404 and 426", async () => {
  for (const p of ["/", "/nope", "/v1/lobby/4d5307e6", "/v1/lobby/4D5307E", "/v1/room/ABC", "/v1/room/0000I0", "/v1/room/000000/x"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await fetch(base + "/v1/lobby/4D5307E6")).status, 426);
  assert.equal((await fetch(base + "/v1/room/000000")).status, 426);
});

test("join, welcome, peers, update, close (private room, mixed titles)", async () => {
  turnMode = "array";
  const p = privRoom();
  const a = await connect(p);
  a.send(join(1, { relay: "198.51.100.7:50000" }));
  const wa = await a.next();
  assert.equal(wa.t, "welcome");
  assert.equal(wa.v, 1);
  assert.match(wa.secret, /^[0-9a-f]{16}$/);
  assert.deepEqual(await a.next(), { t: "peers", peers: [] });

  const b = await connect(p);
  b.send(join(2, { title: "41560817", version: 4294967295, candidates: [] }));
  const wb = await b.next();
  assert.equal(wb.secret, wa.secret);
  const pb = await b.next();
  assert.equal(pb.t, "peers");
  assert.deepEqual(pb.peers, [{
    mac: mac(1), title: "4D5307E6", version: 123,
    candidates: ["192.168.1.1:40000"], relay: "198.51.100.7:50000",
  }]);
  const pa = await a.next();
  assert.deepEqual(pa.peers, [{
    mac: mac(2), title: "41560817", version: 4294967295, candidates: [],
  }]);

  b.send({ t: "update", candidates: ["203.0.113.5:40001", "[2001:db8::1]:40002"], relay: "198.51.100.7:50002" });
  const ua = await a.next();
  assert.deepEqual(ua.peers[0].candidates, ["203.0.113.5:40001", "[2001:db8::1]:40002"]);
  assert.equal(ua.peers[0].relay, "198.51.100.7:50002");
  await b.next(); // b gets its own peers refresh

  b.send({ t: "update", candidates: [] }); // missing relay removes it
  const ua2 = await a.next();
  assert.equal(ua2.peers[0].relay, undefined);
  assert.deepEqual(ua2.peers[0].candidates, []);
  await b.next();

  b.close();
  assert.deepEqual((await a.next()).peers, []);
  a.close();
});

test("ping -> pong", async () => {
  const c = await connect("/v1/lobby/4D5307E6");
  c.send("ping");
  assert.equal(await c.next(), "pong");
  c.send(join(1));
  assert.equal((await c.next()).t, "welcome");
  await c.next();
  c.send("ping");
  assert.equal(await c.next(), "pong");
  c.close();
});

test("ice.turn parsed from mock (array)", async () => {
  turnMode = "array";
  turnCalls.length = 0;
  const c = await connect(privRoom());
  c.send(join(1));
  const w = await c.next();
  assert.deepEqual(w.ice, {
    stun: ["stun.cloudflare.com:3478", "stun.cloudflare.com:53"],
    turn: {
      servers: ["turn.cloudflare.com:3478", "turn.cloudflare.com:53", "turn2.example.com:3478"],
      username: w.ice.turn.username, credential: "cred1", ttl: 3600,
    },
  });
  assert.match(w.ice.turn.username, /^user\d+$/);
  assert.equal(turnCalls.length, 1);
  assert.equal(turnCalls[0].method, "POST");
  assert.equal(turnCalls[0].url, "/v1/turn/keys/testkey/credentials/generate-ice-servers");
  assert.equal(turnCalls[0].auth, "Bearer testtoken");
  assert.deepEqual(JSON.parse(turnCalls[0].body), { ttl: 3600 });
  c.close();
});

test("ice.turn parsed from mock (single object)", async () => {
  turnMode = "object";
  const c = await connect(privRoom());
  c.send(join(1));
  const w = await c.next();
  assert.deepEqual(w.ice.turn.servers, ["turn.cloudflare.com:3478", "turn.cloudflare.com:53", "turn2.example.com:3478"]);
  assert.match(w.ice.turn.username, /^user\d+$/);
  assert.deepEqual(w.ice.stun, ["stun.cloudflare.com:3478"]); // object has no stun URLs -> default
  turnMode = "array";
  c.close();
});

test("stun-only ice when the mock fails", async () => {
  turnMode = "fail";
  const c = await connect(privRoom());
  c.send(join(1));
  const w = await c.next();
  assert.deepEqual(w.ice, { stun: ["stun.cloudflare.com:3478"] });
  turnMode = "array";
  c.close();
});

test("lobby accepts matching title, rejects mismatch", async () => {
  const ok = await connect("/v1/lobby/4D5307E6");
  ok.send(join(1));
  assert.equal((await ok.next()).t, "welcome");
  ok.close();
  const bad = await connect("/v1/lobby/4D5307E6");
  bad.send(join(2, { title: "41560817" }));
  await expectReject(bad, "bad_request", 4000);
});

test("full: the 17th player", async () => {
  const p = privRoom();
  const cs = [];
  for (let i = 1; i <= 16; i++) {
    const c = await connect(p);
    c.send(join(i));
    assert.equal((await c.next()).t, "welcome");
    cs.push(c);
  }
  const extra = await connect(p);
  extra.send(join(17));
  await expectReject(extra, "full", 4001);
  // the room is intact: a leaver frees a slot
  cs[0].close();
  await new Promise((r) => setTimeout(r, 300));
  const again = await connect(p);
  again.send(join(17));
  assert.equal((await again.next()).t, "welcome");
  cs.forEach((c) => c.close());
  again.close();
});

test("duplicate_mac", async () => {
  const p = privRoom();
  const a = await connect(p);
  a.send(join(1));
  assert.equal((await a.next()).t, "welcome");
  const b = await connect(p);
  b.send(join(1));
  await expectReject(b, "duplicate_mac", 4002);
  a.close();
});

test("same mac replaces a closed player", async () => {
  const p = privRoom();
  const a = await connect(p);
  const keeper = await connect(p);
  keeper.send(join(9));
  await keeper.next(); await keeper.next();
  a.send(join(1));
  await a.next();
  a.close();
  await new Promise((r) => setTimeout(r, 300));
  const b = await connect(p);
  b.send(join(1));
  assert.equal((await b.next()).t, "welcome");
  keeper.close(); b.close();
});

test("ice: fresh credentials, but not too often", async () => {
  turnMode = "array";
  const early = await connect(privRoom());
  early.send({ t: "ice" });
  await expectReject(early, "bad_request", 4000);

  const c = await connect(privRoom());
  c.send(join(1));
  assert.equal((await c.next()).t, "welcome");
  assert.equal((await c.next()).t, "peers");
  c.send({ t: "ice" });
  c.send("ping"); // too soon: ignored, still connected
  assert.equal(await c.next(), "pong");

  const d = await connect(privRoom());
  d.send(join(2));
  assert.equal((await d.next()).t, "welcome");
  assert.equal((await d.next()).t, "peers");
  await new Promise((r) => setTimeout(r, 1600));
  turnCalls.length = 0;
  d.send({ t: "ice" });
  const m = await d.next();
  assert.equal(m.t, "ice");
  assert.match(m.ice.turn.username, /^user\d+$/);
  assert.equal(turnCalls.length, 1);
  d.send({ t: "ice" });
  d.send("ping");
  assert.equal(await d.next(), "pong");
  assert.equal(turnCalls.length, 1);
  c.close(); d.close();
});

test("version", async () => {
  for (const v of [2, 0]) {
    const c = await connect(privRoom());
    c.send(join(1, { v }));
    await expectReject(c, "version", 4003);
  }
});

test("bad_request: malformed JSON, bad fields, first message not join", async () => {
  const cases = [
    "not json", "[]", "null", "42", JSON.stringify({ t: "nope" }), JSON.stringify({}),
    JSON.stringify({ t: "update", candidates: [] }), // update before join
    join(1, { v: "1" }), join(1, { v: undefined }),
    join(1, { mac: "001DD8010203" }), join(1, { mac: "001dd80102" }), join(1, { mac: 5 }),
    join(1, { title: "4d5307e6" }), join(1, { title: "4D5307E" }),
    join(1, { version: -1 }), join(1, { version: 4294967296 }), join(1, { version: 1.5 }), join(1, { version: "1" }),
    join(1, { candidates: "x" }), join(1, { candidates: ["nope"] }), join(1, { candidates: ["1.2.3.4"] }),
    join(1, { candidates: ["1.2.3.999:5"] }), join(1, { candidates: ["1.2.3.4:70000"] }),
    join(1, { candidates: ["1.2.3.4:0"] }), join(1, { candidates: ["0.0.0.0:5"] }),
    join(1, { candidates: ["224.0.0.1:5"] }), join(1, { candidates: ["255.255.255.255:5"] }),
    join(1, { candidates: ["[::]:5"] }), join(1, { candidates: ["[ff02::1]:5"] }),
    join(1, { relay: "0.0.0.0:5" }),
    join(1, { candidates: Array(9).fill("1.2.3.4:5") }), join(1, { candidates: undefined }),
    join(1, { relay: 5 }), join(1, { relay: "bad" }),
    join(1, { pad: "x".repeat(2100) }),
  ];
  for (const bad of cases) {
    const c = await connect(privRoom());
    c.send(bad);
    try {
      await expectReject(c, "bad_request", 4000);
    } catch (e) {
      e.message = "case " + (typeof bad === "string" ? bad : JSON.stringify(bad).slice(0, 120)) + ": " + e.message;
      throw e;
    }
  }
  // 8 candidates is fine
  const ok = await connect(privRoom());
  ok.send(join(1, { candidates: Array.from({ length: 8 }, (_, i) => `10.0.0.1:${4000 + i}`) }));
  assert.equal((await ok.next()).t, "welcome");
  await ok.next(); // peers
  // second join, bad update, binary frame, after joining
  ok.send(join(1));
  await expectReject(ok, "bad_request", 4000);
  const u = await connect(privRoom());
  u.send(join(1)); await u.next(); await u.next();
  u.send({ t: "update", candidates: ["x"] });
  await expectReject(u, "bad_request", 4000);
  const bin = await connect(privRoom());
  bin.ws.send(new Uint8Array([1, 2, 3]));
  await expectReject(bin, "bad_request", 4000);
});

test("no join within 10 seconds -> bad_request", async () => {
  const c = await connect(privRoom());
  const t0 = Date.now();
  // After the alarm wakes the hibernated Room, local workerd sends the close frame but
  // never ends the TCP connection, so Node's client stays CLOSING and reports no close
  // event. Check the reject and that the client saw the close frame (CLOSING/CLOSED).
  assert.deepEqual(await c.next(14000), { t: "reject", reason: "bad_request" });
  const dt = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(c.ws.readyState >= 2, "client did not see the close frame");
  assert.ok(dt >= 8000 && dt < 14000, "deadline took " + dt + " ms");
});

test("online: public lobbies list their players, private rooms don't", async () => {
  const title = freshTitle();
  await expectOnline(title, 0);
  const a = await connect("/v1/lobby/" + title);
  a.send(join(1, { title }));
  assert.equal((await a.next()).t, "welcome");
  await expectOnline(title, 1);
  const b = await connect("/v1/lobby/" + title);
  b.send(join(2, { title }));
  assert.equal((await b.next()).t, "welcome");
  await expectOnline(title, 2);
  const c = await connect(privRoom());
  c.send(join(3, { title }));
  assert.equal((await c.next()).t, "welcome");
  // A player still joining isn't counted until it has a slot.
  const d = await connect("/v1/lobby/" + title);
  await new Promise((r) => setTimeout(r, 300));
  await expectOnline(title, 2);
  a.close();
  await expectOnline(title, 1);
  b.close();
  d.close();
  await expectOnline(title, 0);
  c.close();
});

test("online: private rooms count only into a total", async () => {
  const inPrivate = async () => {
    const r = await fetch(base + "/v1/online");
    const body = await r.json();
    assert.ok(Number.isInteger(body.private) && body.private >= 0, "private is a count");
    return body.private;
  };
  // Other tests' rooms may still be leaving.
  const until = async (ok, what) => {
    const deadline = Date.now() + 3000;
    for (let n = await inPrivate(); !ok(n); n = await inPrivate()) {
      if (Date.now() > deadline) assert.fail(`${what}: directory has ${n}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // Settled: the same count twice, half a second apart.
  let before = await inPrivate();
  for (let settled = false; !settled; ) {
    await new Promise((r) => setTimeout(r, 500));
    const n = await inPrivate();
    settled = n === before;
    before = n;
  }
  const room = privRoom();
  const a = await connect(room);
  a.send(join(1));
  assert.equal((await a.next()).t, "welcome");
  const b = await connect(room);
  b.send(join(2));
  assert.equal((await b.next()).t, "welcome");
  await until((n) => n >= before + 2, "two players in a private room");
  const body = await (await fetch(base + "/v1/online")).json();
  assert.ok(!JSON.stringify(body).includes(room.split("/").pop()), "the code isn't listed");
  const with2 = await inPrivate();
  a.close();
  b.close();
  await until((n) => n <= with2 - 2, "both left");
});

test("online: a rejected player isn't counted", async () => {
  const title = freshTitle();
  const a = await connect("/v1/lobby/" + title);
  a.send(join(1, { title }));
  assert.equal((await a.next()).t, "welcome");
  await expectOnline(title, 1);
  const b = await connect("/v1/lobby/" + title);
  b.send(join(1, { title }));
  await expectReject(b, "duplicate_mac", 4002);
  await expectOnline(title, 1);
  a.close();
  await expectOnline(title, 0);
});

test("online: players joining and leaving at once", async () => {
  const title = freshTitle();
  const players = await Promise.all(Array.from({ length: 8 }, (_, i) => connect("/v1/lobby/" + title)));
  players.forEach((c, i) => c.send(join(100 + i, { title })));
  for (const c of players) assert.equal((await c.next()).t, "welcome");
  await expectOnline(title, 8);
  players.slice(0, 5).forEach((c) => c.close());
  await expectOnline(title, 3);
  players.slice(5).forEach((c) => c.close());
  await expectOnline(title, 0);
});

test("online: GET and HEAD only", async () => {
  assert.equal((await fetch(base + "/v1/online", { method: "POST", body: "{}" })).status, 405);
  const head = await fetch(base + "/v1/online", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.match(head.headers.get("cache-control"), /^public, max-age=\d+$/);
  assert.equal((await fetch(base + "/v1/online/x")).status, 404);
});

// ---- Apps open ----
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function here(id, param = "here") {
  const r = await fetch(base + "/v1/online" + (id === undefined ? "" : `?${param}=` + id));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.v, 1);
  assert.equal(typeof body.titles, "object");
  assert.ok(Number.isInteger(body.here) && body.here >= 0, "here is a count");
  return body.here;
}

test("online: open apps are counted once each, until they leave or go quiet", async () => {
  const id = () => randomBytes(8).toString("hex");
  const a = id(), b = id();
  const before = await here();
  assert.equal(await here(a), before + 1);
  assert.equal(await here(a), before + 1, "the same app counts once");
  assert.equal(await here(b), before + 2);
  for (const bad of ["", "XYZ", "0123456789ABCDEF", a + "0", "../" + a]) {
    assert.equal(await here(encodeURIComponent(bad)), before + 2, `"${bad}" isn't an app`);
    assert.equal(await here(encodeURIComponent(bad), "gone"), before + 2, `"${bad}" isn't an app`);
  }
  assert.equal(await here(a, "gone"), before + 1, "an app that leaves stops counting");
  assert.equal(await here(a, "gone"), before + 1);
  assert.equal(await here(a), before + 2, "and counts again when it's back");
  // HERE_MS is 1500 in the test.
  await pause(1700);
  assert.equal(await here(), 0);
  assert.equal(await here(b), 1);
});

// ---- TURN budget ----
// Past TURN_USAGE_CHECK_MS (400 ms in the test), so the next credential reads the usage again.
const afterUsageCheck = () => pause(600);

test("turn: credentials only while the usage reads under the cap", async () => {
  usageMode = "ok"; usageBytes = 0.5e9; // cap is 1 GB in the test
  await afterUsageCheck();
  usageCalls.length = 0;
  const a = await connect(privRoom());
  a.send(join(1));
  const wa = await a.next();
  assert.ok(wa.ice.turn, "under the cap: TURN");
  // Read for the join, or by the check that runs while credentials are live.
  for (let i = 0; i < 20 && !usageCalls.length; i++) await pause(100);
  assert.ok(usageCalls.length >= 1);
  assert.equal(usageCalls[0].auth, "Bearer testanalytics");
  const q = JSON.parse(usageCalls[0].body).query;
  assert.match(q, /accountTag: "0123456789abcdef0123456789abcdef"/);
  assert.match(q, /callsTurnUsageAdaptiveGroups/);
  const [, from, to] = /date_geq: "([\d-]+)", date_leq: "([\d-]+)"/.exec(q);
  assert.equal((Date.parse(to) - Date.parse(from)) / 86_400_000, 30, "the last 31 days");

  revoked.length = 0;
  usageBytes = 1.2e9;
  await afterUsageCheck();
  const b = await connect(privRoom());
  b.send(join(2));
  const wb = await b.next();
  assert.deepEqual(wb.ice, { stun: ["stun.cloudflare.com:3478"] }, "over the cap: STUN only");
  assert.ok(revoked.includes(wa.ice.turn.username), "over the cap: live credentials revoked");

  for (const mode of ["fail", "errors"]) {
    usageMode = mode; usageBytes = 0;
    await afterUsageCheck();
    const c = await connect(privRoom());
    c.send(join(3));
    assert.deepEqual((await c.next()).ice, { stun: ["stun.cloudflare.com:3478"] }, `usage ${mode}: STUN only`);
    c.close();
  }
  usageMode = "ok"; usageBytes = 0;
  await afterUsageCheck();
  a.close(); b.close();
});

test("turn: the cap revokes live credentials without a new join", async () => {
  usageMode = "ok"; usageBytes = 0;
  await afterUsageCheck();
  const a = await connect(privRoom());
  a.send(join(1));
  const user = (await a.next()).ice.turn.username;
  revoked.length = 0;
  usageBytes = 5e9;
  const deadline = Date.now() + 5000;
  while (!revoked.includes(user) && Date.now() < deadline) await pause(100);
  assert.ok(revoked.includes(user), "the usage check revoked it");
  usageBytes = 0;
  await afterUsageCheck();
  a.close();
});

test("turn: credentials are revoked when their player leaves", async () => {
  usageMode = "ok"; usageBytes = 0;
  const p = privRoom();
  const a = await connect(p);
  a.send(join(1));
  const user = (await a.next()).ice.turn.username;
  revoked.length = 0;
  a.close();
  const deadline = Date.now() + 3000;
  while (!revoked.includes(user) && Date.now() < deadline) await pause(50);
  assert.deepEqual(revoked, [user]);
});

test("turn: at most TURN_MAX_LIVE credentials at once", async () => {
  usageMode = "ok"; usageBytes = 0;
  await afterUsageCheck();
  const players = [];
  let turn = 0, stun = 0;
  // 24 in the test, across rooms of up to 16.
  const rooms = [privRoom(), privRoom()];
  for (let i = 0; i < 26; i++) {
    const c = await connect(rooms[i < 13 ? 0 : 1], `198.51.100.${i + 1}`);
    c.send(join(200 + i));
    const w = await c.next();
    if (w.ice.turn) turn++; else stun++;
    players.push(c);
  }
  assert.equal(turn, 24);
  assert.equal(stun, 2);
  players[0].close();
  await pause(500);
  const c = await connect(privRoom(), "198.51.100.200");
  c.send(join(300));
  assert.ok((await c.next()).ice.turn, "a slot freed by a player leaving");
  c.close();
  players.forEach((p) => p.close());
  await pause(500);
});

test("turn: at most TURN_MAX_PER_IP credentials to one address", async () => {
  usageMode = "ok"; usageBytes = 0;
  await afterUsageCheck();
  const room = privRoom();
  const players = [];
  const got = [];
  for (let i = 0; i < 4; i++) {
    const c = await connect(room, "203.0.113.77");
    c.send(join(400 + i));
    got.push(!!(await c.next()).ice.turn);
    players.push(c);
  }
  assert.deepEqual(got, [true, true, true, false]);
  const other = await connect(room, "203.0.113.78");
  other.send(join(410));
  assert.ok((await other.next()).ice.turn, "another address still gets TURN");
  players[0].close();
  await pause(500);
  const again = await connect(room, "203.0.113.77");
  again.send(join(411));
  assert.ok((await again.next()).ice.turn, "a slot freed by a player leaving");
  [...players, other, again].forEach((p) => p.close());
  await pause(500);
});

test("new secret after the room empties", async () => {
  const p = privRoom();
  const a = await connect(p);
  a.send(join(1));
  const s1 = (await a.next()).secret;
  const b = await connect(p);
  b.send(join(2));
  assert.equal((await b.next()).secret, s1);
  a.close();
  await new Promise((r) => setTimeout(r, 300));
  const c = await connect(p);
  c.send(join(3));
  assert.equal((await c.next()).secret, s1, "secret must stay while b is in the room");
  b.close(); c.close();
  await new Promise((r) => setTimeout(r, 500));
  const d = await connect(p);
  d.send(join(4));
  const s2 = (await d.next()).secret;
  assert.match(s2, /^[0-9a-f]{16}$/);
  assert.notEqual(s2, s1);
  d.close();
});

// ---- runner ----
let wr;
let wranglerLog = "";
async function main() {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;
  const port = await freePort();
  const inspector = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Fresh state each run, so no live credentials or lobbies carry over.
  fs.rmSync(path.join(root, ".wrangler/test-state"), { recursive: true, force: true });
  wsBase = `ws://127.0.0.1:${port}`;
  wr = spawn(
    path.join(root, "node_modules/.bin/wrangler"),
    [
      "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
      "--var", `TURN_API_BASE:http://127.0.0.1:${mockPort}`,
      "--var", "TURN_KEY_ID:testkey", "--var", "TURN_KEY_API_TOKEN:testtoken",
      "--var", "ICE_INTERVAL_MS:1500", "--var", "ONLINE_CACHE_MS:0", "--var", "HERE_MS:1500",
      "--var", "CF_ACCOUNT_ID:0123456789abcdef0123456789abcdef", "--var", "CF_ANALYTICS_TOKEN:testanalytics",
      "--var", `GRAPHQL_API:http://127.0.0.1:${mockPort}/graphql`,
      "--var", "TURN_CAP_GB:1", "--var", "TURN_MAX_LIVE:24", "--var", "TURN_MAX_PER_IP:3", "--var", "TURN_USAGE_CHECK_MS:400",
      "--persist-to", path.join(root, ".wrangler/test-state"),
    ],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  wr.stdout.on("data", (d) => (wranglerLog += d));
  wr.stderr.on("data", (d) => (wranglerLog += d));
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    if (wr.exitCode !== null) throw new Error("wrangler exited early");
    try { up = (await fetch(base + "/v1/health")).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) throw new Error("wrangler dev did not start");

  let pass = 0, fail = 0;
  for (const [i, [name, fn]] of tests.entries()) {
    testIp = `10.0.${i >> 8}.${(i & 255) + 1}`;
    try {
      await fn();
      pass++;
      console.log("ok   - " + name);
    } catch (e) {
      fail++;
      console.log("FAIL - " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 14).join("\n       "));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("harness error:", e.message);
  console.error(wranglerLog.split("\n").slice(-15).join("\n"));
} finally {
  clients.forEach((c) => c.close());
  if (wr && wr.exitCode === null) {
    wr.kill("SIGTERM");
    await new Promise((r) => { wr.on("exit", r); setTimeout(() => { wr.kill("SIGKILL"); r(); }, 5000); });
  }
  mock.close();
}
process.exit(code ? 1 : 0);
