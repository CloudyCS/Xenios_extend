// XeniOS System Link lobby. See PROTOCOL.md.
import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: any;
  DIRECTORY: any;
  TURN: any;
  TURN_API_BASE: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  // Reading TURN usage, without which no TURN credentials are handed out.
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  TURN_CAP_GB?: string;
  TURN_MAX_LIVE?: string;
  TURN_MAX_PER_IP?: string;
  ICE_INTERVAL_MS?: string; // tests only
  ONLINE_CACHE_MS?: string; // tests only
  GRAPHQL_API?: string; // tests only
  TURN_USAGE_CHECK_MS?: string; // tests only
  HERE_MS?: string; // tests only
}

const MAX_MESSAGE_BYTES = 2048;
const MAX_CANDIDATES = 8;
const MAX_PLAYERS = 16;
const JOIN_DEADLINE_MS = 10_000;
const SILENCE_MS = 60_000;
const TURN_TIMEOUT_MS = 3000;
// TURN is the one part of the lobby Cloudflare bills for: past the first 1,000 GB a month sent
// from TURN to players, $0.05 per GB. There's no spending cap, so the Worker keeps its own: no
// TURN credentials while the account's TURN traffic over the last 31 days (any billing month
// fits in that) is over TURN_CAP_GB, or while it can't be read, and at most TURN_MAX_LIVE
// credentials at once (TURN_MAX_PER_IP from one address), each good for an hour and revoked when
// its player leaves or the cap is reached. Workers and Durable Objects on the Workers Free plan stop at their limits and never
// bill.
const TURN_TTL = 3600;
const TURN_CAP_GB = 400;
const TURN_MAX_LIVE = 32;
const TURN_MAX_PER_IP = 4;
// How often the usage is read again while credentials are live.
const TURN_USAGE_CHECK_MS = 2 * 60_000;
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";
// A player asks for fresh TURN credentials ("ice") at most this often.
const ICE_INTERVAL_MS = 60_000;
const DEFAULT_STUN = "stun.cloudflare.com:3478";
// Public lobbies tell the directory their player count on every change, and again this often.
const ONLINE_REFRESH_MS = 5 * 60_000;
// The directory forgets a lobby it hasn't heard from for this long.
const ONLINE_STALE_MS = 15 * 60_000;
// How long a Worker reuses its answer to GET /v1/online, and clients may cache it.
const ONLINE_CACHE_MS = 60_000;
const MAX_ONLINE_TITLES = 100;
// An app that says it's open (GET /v1/online?here=<id>) counts for this long. Apps say so every
// 5 minutes.
const HERE_MS = 6 * 60_000;
const HERE_ID = /^[0-9a-f]{16}$/;

const CLOSE = { bad_request: 4000, full: 4001, duplicate_mac: 4002, version: 4003 } as const;
type Reason = keyof typeof CLOSE;

const TITLE = /^[0-9A-F]{8}$/;
const LOBBY_PATH = /^\/v1\/lobby\/([0-9A-F]{8})$/;
const ROOM_PATH = /^\/v1\/room\/([0-9A-HJKMNP-TV-Z]{6})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/v1/health") return new Response("ok", { status: 200 });
    if (path === "/v1/online") return online(request, env);
    let name: string | null = null;
    let m = LOBBY_PATH.exec(path);
    if (m) name = "lobby:" + m[1];
    else if ((m = ROOM_PATH.exec(path))) name = "room:" + m[1];
    if (!name) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("upgrade required", { status: 426 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(request);
  },
};

function directory(env: Env): any {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}

// The last answer to GET /v1/online, per Worker instance.
let onlineCache: { at: number; body: string } | undefined;

async function online(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const cacheMs = Number(env.ONLINE_CACHE_MS ?? ONLINE_CACHE_MS);
  const now = Date.now();
  // An app saying it's open, or that it's leaving, gets a fresh answer that counts it, or not.
  const params = new URL(request.url).searchParams;
  const here = params.get("here");
  const gone = params.get("gone");
  if (here !== null && HERE_ID.test(here)) {
    const counts = await directory(env).here(here);
    onlineCache = { at: now, body: JSON.stringify({ v: 1, ...counts }) };
  } else if (gone !== null && HERE_ID.test(gone)) {
    const counts = await directory(env).gone(gone);
    onlineCache = { at: now, body: JSON.stringify({ v: 1, ...counts }) };
  } else if (!onlineCache || now - onlineCache.at >= cacheMs) {
    const counts = await directory(env).list();
    onlineCache = { at: now, body: JSON.stringify({ v: 1, ...counts }) };
  }
  return new Response(request.method === "HEAD" ? null : onlineCache.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=" + Math.floor(cacheMs / 1000),
    },
  });
}

type Counts = { titles: Record<string, number>; private: number; here: number };

// How many players each title's public lobby has, and how many apps are open. Private rooms are
// never listed, and an app is only a random ID it makes up each launch.
export class Directory extends DurableObject<Env> {
  async report(title: string, players: number): Promise<void> {
    if (typeof title !== "string" || !TITLE.test(title)) return;
    if (Number.isInteger(players) && players > 0) {
      await this.ctx.storage.put("t:" + title, { players, at: Date.now() });
    } else {
      await this.ctx.storage.delete("t:" + title);
    }
  }

  // How many players a private room has, by its Durable Object's ID, which doesn't say its code.
  async reportPrivate(room: string, players: number): Promise<void> {
    if (typeof room !== "string" || !/^[0-9a-f]{64}$/.test(room)) return;
    if (Number.isInteger(players) && players > 0) {
      await this.ctx.storage.put("p:" + room, { players, at: Date.now() });
    } else {
      await this.ctx.storage.delete("p:" + room);
    }
  }

  // An app is open now.
  async here(id: string): Promise<Counts> {
    if (typeof id === "string" && HERE_ID.test(id)) await this.ctx.storage.put("h:" + id, Date.now());
    return this.list();
  }

  // An app has closed, or gone to the background.
  async gone(id: string): Promise<Counts> {
    if (typeof id === "string" && HERE_ID.test(id)) await this.ctx.storage.delete("h:" + id);
    return this.list();
  }

  // The busiest lobbies first, how many players are in private rooms, and how many apps are open.
  async list(): Promise<Counts> {
    const now = Date.now();
    const live: [string, number][] = [];
    const stale: string[] = [];
    const entries = (await this.ctx.storage.list({ prefix: "t:" })) as Map<string, { players: number; at: number }>;
    for (const [key, e] of entries) {
      if (now - e.at >= ONLINE_STALE_MS) stale.push(key);
      else live.push([key.slice(2), e.players]);
    }
    let inPrivate = 0;
    const rooms = (await this.ctx.storage.list({ prefix: "p:" })) as Map<string, { players: number; at: number }>;
    for (const [key, e] of rooms) {
      if (now - e.at >= ONLINE_STALE_MS) stale.push(key);
      else inPrivate += e.players;
    }
    let here = 0;
    const hereMs = Number(this.env.HERE_MS ?? HERE_MS);
    const apps = (await this.ctx.storage.list({ prefix: "h:" })) as Map<string, number>;
    for (const [key, at] of apps) {
      if (now - at >= hereMs) stale.push(key);
      else here++;
    }
    for (let i = 0; i < stale.length; i += 128) await this.ctx.storage.delete(stale.slice(i, i + 128));
    live.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return { titles: Object.fromEntries(live.slice(0, MAX_ONLINE_TITLES)), private: inPrivate, here };
  }
}

function turnService(env: Env): any {
  return env.TURN.get(env.TURN.idFromName("turn"));
}

const STUN_ONLY: Ice = { stun: [DEFAULT_STUN] };

// The account's TURN egress over the last 31 days, in bytes, or null when it can't be read.
async function readTurnEgress(env: Env, now: number): Promise<number | null> {
  const account = env.CF_ACCOUNT_ID ?? "";
  if (!/^[0-9a-f]{32}$/.test(account) || !env.CF_ANALYTICS_TOKEN) return null;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // Every TURN key on the account, since they share one bill.
  const query =
    `{ viewer { accounts(filter: {accountTag: "${account}"}) { callsTurnUsageAdaptiveGroups(` +
    `filter: {date_geq: "${day(now - 30 * 86_400_000)}", date_leq: "${day(now)}"}, limit: 1000) ` +
    `{ sum { egressBytes } } } } }`;
  try {
    const res = await fetch(env.GRAPHQL_API ?? GRAPHQL_API, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.CF_ANALYTICS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    if (Array.isArray(body?.errors) && body.errors.length) return null;
    const accounts = body?.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) return null;
    const groups = accounts[0]?.callsTurnUsageAdaptiveGroups;
    if (!Array.isArray(groups) || groups.length >= 1000) return null;
    let bytes = 0;
    for (const g of groups) {
      const b = Number(g?.sum?.egressBytes);
      if (!Number.isFinite(b) || b < 0) return null;
      bytes += b;
    }
    return bytes;
  } catch {
    return null;
  }
}

async function revokeTurn(env: Env, username: string): Promise<boolean> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return false;
  try {
    const url =
      env.TURN_API_BASE.replace(/\/+$/, "") + "/v1/turn/keys/" + encodeURIComponent(env.TURN_KEY_ID) +
      "/credentials/" + encodeURIComponent(username) + "/revoke";
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.TURN_KEY_API_TOKEN },
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// Hands out every TURN credential, within the limits above.
// Live TURN credentials: when they expire, and a hash of the address they went to.
type Live = Map<string, { until: number; ip: string }>;

async function hashIp(ip: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("xenios-turn:" + ip));
  return Array.from(new Uint8Array(d).slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
}

export class Turn extends DurableObject<Env> {
  // Credentials being asked for now, in all and per address, which count against the limits.
  private pending = 0;
  private pendingIp = new Map<string, number>();

  private capBytes(): number {
    return Number(this.env.TURN_CAP_GB ?? TURN_CAP_GB) * 1e9;
  }

  private checkMs(): number {
    return Number(this.env.TURN_USAGE_CHECK_MS ?? TURN_USAGE_CHECK_MS);
  }

  // Without the expired ones.
  private async live(now: number): Promise<Live> {
    const all = ((await this.ctx.storage.get("live")) ?? {}) as Record<string, { until: number; ip: string }>;
    return new Map(Object.entries(all).filter(([, c]) => c.until > now));
  }

  private async saveLive(live: Live): Promise<void> {
    await this.ctx.storage.put("live", Object.fromEntries(live));
  }

  // Whether the last reading is under the cap, reading again when it's old. Unreadable is over.
  private async underCap(now: number, force = false): Promise<boolean> {
    const usage = (await this.ctx.storage.get("usage")) as { bytes: number; at: number } | undefined;
    if (!force && usage && now - usage.at < this.checkMs()) return usage.bytes < this.capBytes();
    const bytes = await readTurnEgress(this.env, now);
    if (bytes === null) {
      console.log("turn usage unreadable: no TURN credentials");
      await this.ctx.storage.delete("usage");
      return false;
    }
    await this.ctx.storage.put("usage", { bytes, at: now });
    const under = bytes < this.capBytes();
    if (!under) console.log(`turn usage ${(bytes / 1e9).toFixed(1)} GB is over the cap: no TURN credentials`);
    return under;
  }

  // ip: the player's address, as Cloudflare saw it.
  async issue(ip: string): Promise<Ice> {
    const now = Date.now();
    const key = await hashIp(ip);
    const live = await this.live(now);
    const max = Number(this.env.TURN_MAX_LIVE ?? TURN_MAX_LIVE);
    const maxPerIp = Number(this.env.TURN_MAX_PER_IP ?? TURN_MAX_PER_IP);
    const fromIp = [...live.values()].filter((c) => c.ip === key).length + (this.pendingIp.get(key) ?? 0);
    if (live.size + this.pending >= max || fromIp >= maxPerIp) return STUN_ONLY;
    this.pending++;
    this.pendingIp.set(key, (this.pendingIp.get(key) ?? 0) + 1);
    try {
      if (!(await this.underCap(now))) {
        await this.revokeAll();
        return STUN_ONLY;
      }
      const ice = await requestIce(this.env);
      if (!ice.turn) return ice;
      const current = await this.live(Date.now());
      current.set(ice.turn.username, { until: now + ice.turn.ttl * 1000, ip: key });
      await this.saveLive(current);
      await this.schedule();
      return ice;
    } finally {
      this.pending--;
      const left = (this.pendingIp.get(key) ?? 1) - 1;
      if (left) this.pendingIp.set(key, left);
      else this.pendingIp.delete(key);
    }
  }

  // The player that had these credentials left.
  async release(usernames: string[]): Promise<void> {
    await this.revoke(usernames.filter((u) => typeof u === "string"));
  }

  private async revokeAll(): Promise<void> {
    await this.revoke([...(await this.live(Date.now())).keys()]);
  }

  // Forgets the ones Cloudflare revoked. The list is read again after the revoke requests, which
  // let other calls in, so that one release doesn't write back what another just removed.
  private async revoke(usernames: string[]): Promise<void> {
    const ok = await Promise.all(usernames.map((u) => revokeTurn(this.env, u)));
    const live = await this.live(Date.now());
    usernames.forEach((u, i) => ok[i] && live.delete(u));
    await this.saveLive(live);
  }

  private async schedule(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.checkMs());
  }

  // While credentials are live, reads the usage again and revokes them all once it's over the cap.
  async alarm(): Promise<void> {
    const now = Date.now();
    const live = await this.live(now);
    await this.saveLive(live);
    if (live.size === 0) return;
    if (!(await this.underCap(now, true))) await this.revokeAll();
    if ((await this.live(Date.now())).size) await this.ctx.storage.setAlarm(Date.now() + this.checkMs());
  }
}

// Per-socket state, kept in the WebSocket attachment (survives hibernation).
interface Att {
  connectedAt: number;
  lastSeen: number;
  ip?: string; // CF-Connecting-IP, for the TURN per-address limit
  joined: boolean;
  welcomed: boolean;
  lobby?: string; // the title ID in a lobby path; unset in private rooms
  mac?: string;
  title?: string;
  version?: number;
  candidates?: string[];
  relay?: string;
  iceAt?: number; // when the player was last sent TURN credentials
  turnUsers?: string[]; // its last two TURN usernames, revoked when it leaves
}

class Bad extends Error {
  reason: Reason;
  constructor(reason: Reason) {
    super(reason);
    this.reason = reason;
  }
}

function validPort(p: string): boolean {
  return +p >= 1 && +p <= 65535;
}

// An address someone could be reached at: not unspecified, multicast or broadcast.
function validAddr(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 64) return false;
  let m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(s);
  if (m) {
    const o = [m[1], m[2], m[3], m[4]].map(Number);
    return o.every((x) => x <= 255) && o[0] !== 0 && o[0] < 224 && validPort(m[5]);
  }
  m = /^\[([0-9A-Fa-f:.]{2,45})\]:(\d{1,5})$/.exec(s);
  if (!m || !m[1].includes(":") || !validPort(m[2])) return false;
  const a = m[1].toLowerCase();
  return !/^[0:.]+$/.test(a) && !a.startsWith("ff");
}

function parseCandidates(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_CANDIDATES || !v.every(validAddr)) throw new Bad("bad_request");
  return v as string[];
}

function parseRelay(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!validAddr(v)) throw new Bad("bad_request");
  return v;
}

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

interface Ice {
  stun: string[];
  turn?: { servers: string[]; username: string; credential: string; ttl: number };
}

// "stun:host:port", "turn:host:port?transport=udp" -> host:port. Null when not usable.
function splitUrl(url: unknown, scheme: string): { hostport: string; params: URLSearchParams } | null {
  if (typeof url !== "string" || !url.startsWith(scheme + ":")) return null;
  const rest = url.slice(scheme.length + 1);
  const q = rest.indexOf("?");
  const hostport = q < 0 ? rest : rest.slice(0, q);
  if (!/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(hostport)) return null;
  return {
    hostport: /:\d+$/.test(hostport) && !/^\[[^\]]*\]$/.test(hostport) ? hostport : hostport + ":3478",
    params: new URLSearchParams(q < 0 ? "" : rest.slice(q + 1)),
  };
}

// TURN credentials from Cloudflare. Only the Turn object asks, so its limits hold.
async function requestIce(env: Env): Promise<Ice> {
  const fallback: Ice = { stun: [DEFAULT_STUN] };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !env.TURN_API_BASE) return fallback;
  try {
    const url =
      env.TURN_API_BASE.replace(/\/+$/, "") +
      "/v1/turn/keys/" + encodeURIComponent(env.TURN_KEY_ID) + "/credentials/generate-ice-servers";
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.TURN_KEY_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (!res.ok) return fallback;
    const body: any = await res.json();
    const raw = body?.iceServers;
    const servers: any[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
    const stun: string[] = [];
    const turn: string[] = [];
    let username = "";
    let credential = "";
    for (const s of servers) {
      if (!s || typeof s !== "object") continue;
      const urls: unknown[] = Array.isArray(s.urls) ? s.urls : s.urls !== undefined ? [s.urls] : [];
      for (const u of urls) {
        const st = splitUrl(u, "stun");
        if (st) {
          if (!stun.includes(st.hostport)) stun.push(st.hostport);
          continue;
        }
        const tn = splitUrl(u, "turn"); // "turns:" does not match "turn:"
        if (tn) {
          const tr = tn.params.get("transport");
          if (tr !== null && tr !== "udp") continue;
          if (typeof s.username !== "string" || typeof s.credential !== "string") continue;
          if (!username) {
            username = s.username;
            credential = s.credential;
          } else if (s.username !== username) continue; // one credential for all servers
          if (!turn.includes(tn.hostport)) turn.push(tn.hostport);
        }
      }
    }
    const ice: Ice = { stun: stun.length ? stun : [DEFAULT_STUN] };
    if (turn.length && username && credential) ice.turn = { servers: turn, username, credential, ttl: TURN_TTL };
    return ice;
  } catch {
    return fallback;
  }
}

export class Room extends DurableObject<Env> {
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const lobby = LOBBY_PATH.exec(new URL(request.url).pathname);
    server.serializeAttachment({
      connectedAt: now, lastSeen: now, joined: false, welcomed: false, lobby: lobby ? lobby[1] : undefined,
      ip: request.headers.get("CF-Connecting-IP") ?? "",
    } as Att);
    await this.reschedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---- helpers ----

  private att(ws: WebSocket): Att {
    return (ws.deserializeAttachment() as Att) ?? { connectedAt: 0, lastSeen: 0, joined: false, welcomed: false };
  }

  private open(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((w: WebSocket) => w !== except && w.readyState === 1);
  }

  private lastSeen(ws: WebSocket, a: Att): number {
    const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(a.lastSeen, auto);
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private reject(ws: WebSocket, reason: Reason): void {
    this.send(ws, { t: "reject", reason });
    try {
      ws.close(CLOSE[reason], reason);
    } catch {}
  }

  private broadcastPeers(): void {
    const all = this.open().map((w) => ({ w, a: this.att(w) }));
    const players = all.filter((x) => x.a.joined);
    for (const me of all) {
      if (!me.a.welcomed) continue;
      const peers = players
        .filter((p) => p.w !== me.w)
        .map((p) => {
          const o: any = {
            mac: p.a.mac, title: p.a.title, version: p.a.version, candidates: p.a.candidates ?? [],
          };
          if (p.a.relay) o.relay = p.a.relay;
          return o;
        });
      this.send(me.w, { t: "peers", peers });
    }
  }

  private async releaseTurn(a: Att): Promise<void> {
    if (!a.turnUsers?.length) return;
    try {
      await turnService(this.env).release(a.turnUsers);
    } catch {} // they expire within the hour regardless
  }

  // Remembers the credentials a player was sent: the old ones stay good until its new
  // allocation is up.
  private noteTurn(ws: WebSocket, ice: Ice): void {
    if (!ice.turn) return;
    const a = this.att(ws);
    a.turnUsers = [...(a.turnUsers ?? []), ice.turn.username].slice(-2);
    ws.serializeAttachment(a);
  }

  // Called after anything that may have removed a socket.
  private async afterRemoval(removed: WebSocket | undefined, wasJoined: boolean, lobby: string | undefined): Promise<void> {
    await this.reportOnline(lobby, removed);
    const left = this.open(removed);
    if (left.length === 0) {
      await this.ctx.storage.delete("secret");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (wasJoined) {
      this.broadcastPeers();
      this.logLobby("leave", lobby);
    }
    await this.reschedule();
  }

  // Tells the directory how many players this room has: on a change, and again every few minutes
  // so it can forget rooms that went away without saying so. A public lobby by its title; a
  // private room (no title) only by its object's ID, and only counted into a total.
  // Reports can cross on the way, so it checks again after each one.
  private async reportOnline(title: string | undefined, except?: WebSocket): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const players = this.open(except).filter((w) => this.att(w).joined).length;
      const now = Date.now();
      const last = (await this.ctx.storage.get("reported")) as
        | { players: number; at: number; lobby?: string }
        | undefined;
      if (last ? last.players === players && now - last.at < ONLINE_REFRESH_MS : players === 0) return;
      // An emptied lobby has no socket left to name it.
      const lobby = title ?? last?.lobby;
      try {
        if (lobby) await directory(this.env).report(lobby, players);
        else await directory(this.env).reportPrivate(this.ctx.id.toString(), players);
      } catch {
        return; // tried again on the next change or alarm
      }
      if (players) await this.ctx.storage.put("reported", { players, at: now, lobby });
      else await this.ctx.storage.delete("reported");
    }
  }

  private logLobby(ev: string, title?: string): void {
    // Public lobbies only; private room codes are never logged.
    if (!title) return;
    const n = this.open().filter((w) => this.att(w).joined).length;
    console.log(`lobby ${title} ${ev} players=${n}`);
  }

  // Alarm is only set while the room has sockets.
  private async reschedule(): Promise<void> {
    const socks = this.open();
    if (socks.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    let next = Infinity;
    for (const w of socks) {
      const a = this.att(w);
      next = Math.min(next, a.joined ? this.lastSeen(w, a) + SILENCE_MS : a.connectedAt + JOIN_DEADLINE_MS);
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  // ---- WebSocket Hibernation handlers ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.att(ws);
    try {
      if (typeof message !== "string" || new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
        throw new Bad("bad_request");
      }
      let msg: any;
      try {
        msg = JSON.parse(message);
      } catch {
        throw new Bad("bad_request");
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new Bad("bad_request");
      a.lastSeen = Date.now();
      if (msg.t === "join") {
        if (a.joined) throw new Bad("bad_request");
        await this.handleJoin(ws, a, msg);
      } else if (msg.t === "update") {
        if (!a.joined) throw new Bad("bad_request");
        a.candidates = parseCandidates(msg.candidates);
        a.relay = parseRelay(msg.relay);
        ws.serializeAttachment(a);
        this.broadcastPeers();
        await this.reschedule();
      } else if (msg.t === "ice") {
        const interval = Number(this.env.ICE_INTERVAL_MS) || ICE_INTERVAL_MS;
        if (!a.welcomed) throw new Bad("bad_request");
        // Asked too soon: the credentials it has are still fresh.
        if (a.lastSeen - (a.iceAt ?? 0) < interval) return;
        a.iceAt = a.lastSeen;
        ws.serializeAttachment(a);
        const ice: Ice = await turnService(this.env).issue(a.ip ?? "");
        this.noteTurn(ws, ice);
        if (ws.readyState === 1) this.send(ws, { t: "ice", ice });
        else await this.releaseTurn(this.att(ws));
        await this.reschedule();
      } else {
        throw new Bad("bad_request");
      }
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      this.reject(ws, e.reason);
      await this.releaseTurn(this.att(ws));
      await this.afterRemoval(ws, a.joined, a.lobby);
    }
  }

  private async handleJoin(ws: WebSocket, a: Att, msg: any): Promise<void> {
    if (typeof msg.v !== "number" || !Number.isInteger(msg.v)) throw new Bad("bad_request");
    if (msg.v !== 1) throw new Bad("version");
    if (typeof msg.mac !== "string" || !/^[0-9a-f]{12}$/.test(msg.mac)) throw new Bad("bad_request");
    if (typeof msg.title !== "string" || !/^[0-9A-F]{8}$/.test(msg.title)) throw new Bad("bad_request");
    if (!Number.isInteger(msg.version) || msg.version < 0 || msg.version > 4294967295) throw new Bad("bad_request");
    const candidates = parseCandidates(msg.candidates);
    const relay = parseRelay(msg.relay);

    if (a.lobby && a.lobby !== msg.title) throw new Bad("bad_request");

    // Drop stale same-mac players, refuse live ones.
    const now = Date.now();
    let players = 0;
    for (const w of this.open(ws)) {
      const o = this.att(w);
      if (!o.joined) continue;
      if (o.mac === msg.mac) {
        if (now - this.lastSeen(w, o) >= SILENCE_MS) {
          try {
            w.close(1000, "replaced");
          } catch {}
          continue;
        }
        throw new Bad("duplicate_mac");
      }
      players++;
    }
    if (players >= MAX_PLAYERS) throw new Bad("full");

    // Take the slot before any await so racing joins see it.
    a.joined = true;
    a.welcomed = false;
    a.mac = msg.mac;
    a.title = msg.title;
    a.version = msg.version;
    a.candidates = candidates;
    a.relay = relay;
    ws.serializeAttachment(a);

    const [secret, ice] = await Promise.all([
      this.getSecret(),
      turnService(this.env).issue(a.ip ?? "") as Promise<Ice>,
    ]);
    this.noteTurn(ws, ice);
    if (ws.readyState !== 1) {
      // Went away while waiting; its close handler cleaned up before these were noted.
      await this.releaseTurn(this.att(ws));
      return;
    }
    this.send(ws, { t: "welcome", v: 1, secret, ice });
    const cur = this.att(ws);
    cur.welcomed = true;
    cur.iceAt = Date.now();
    ws.serializeAttachment(cur);
    this.broadcastPeers();
    this.logLobby("join", a.lobby);
    await this.reportOnline(a.lobby);
    await this.reschedule();
  }

  private async getSecret(): Promise<string> {
    let s = (await this.ctx.storage.get("secret")) as string | undefined;
    if (!s) {
      s = randomSecret();
      await this.ctx.storage.put("secret", s);
    }
    return s;
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const a = this.att(ws);
    await this.releaseTurn(a);
    await this.afterRemoval(ws, a.joined, a.lobby);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const a = this.att(ws);
    try {
      ws.close(1011, "error");
    } catch {}
    await this.releaseTurn(a);
    await this.afterRemoval(ws, a.joined, a.lobby);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    let lobby: string | undefined;
    for (const w of this.open()) {
      const a = this.att(w);
      if (a.joined) {
        if (now - this.lastSeen(w, a) >= SILENCE_MS) {
          try {
            w.close(1001, "silent");
          } catch {}
          await this.releaseTurn(a);
          changed = true;
          lobby = a.lobby;
        }
      } else if (now - a.connectedAt >= JOIN_DEADLINE_MS) {
        this.reject(w, "bad_request");
        changed = true;
      }
    }
    if (changed) {
      await this.afterRemoval(undefined, true, lobby);
    } else {
      const any = this.open()[0];
      await this.reportOnline(any && this.att(any).lobby);
      await this.reschedule();
    }
  }
}
