# System Link lobby protocol, version 1

The lobby tells the players in a room where the others can be reached. Game
traffic never goes through it: players send it to each other directly, or
through a TURN relay when their networks won't allow that. The lobby hands out
the room's secret, which players put in every probe and frame they send each
other, and the TURN credentials.

## Rooms

| Room | Path | Durable Object name |
| --- | --- | --- |
| A title's public lobby | `/v1/lobby/<title ID>` | `lobby:<title ID>` |
| A private room | `/v1/room/<code>` | `room:<code>` |

- `<title ID>` is 8 hex digits, upper case: `4D5307E6`.
- `<code>` is 6 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Clients
  normalize codes before connecting, so the lobby only accepts them as written.

`GET /v1/health` answers `200 ok`. `GET /v1/online` is described below. Any
other path answers 404, and a room path without a WebSocket upgrade answers 426.

## Messages

The client opens a WebSocket on the room's path. Every message is a JSON text
frame with a `t` field, except the keepalive, which is the text `ping`.
Messages over 2048 bytes are refused (`bad_request`).

### Client to lobby

`join` is the first message, within 10 seconds of the upgrade:

```json
{"t": "join", "v": 1, "mac": "001dd8010203", "title": "4D5307E6",
 "version": 123, "candidates": ["192.168.1.5:40000", "203.0.113.5:40000"],
 "relay": "198.51.100.7:50000"}
```

- `v`: the protocol version, 1.
- `mac`: the console's MAC, 12 hex digits, lower case.
- `title`: the title ID, 8 hex digits, upper case. In a private room the
  players may run different titles; in a lobby it must match the path.
- `version`: the title's version, an integer from 0 to 4294967295.
- `candidates`: up to 8 addresses the player may be reached at directly, as
  `a.b.c.d:port` or `[v6]:port`, never port 0 or an unspecified, multicast or
  broadcast address. May be empty.
- `relay`: optional. The player's TURN relayed address, in the same form.

`update` replaces the player's `candidates` and `relay` (a missing `relay`
removes it):

```json
{"t": "update", "candidates": ["203.0.113.5:40001"], "relay": "198.51.100.7:50002"}
```

`ice` asks for new TURN credentials, which a player needs for a new
allocation before its credentials expire. It's answered at most once a minute,
and not within a minute of the `welcome`; one asked sooner is ignored:

```json
{"t": "ice"}
```

`ping` (the bare text) is answered with `pong` without waking the room.
Clients send it every 20 seconds. A player that has sent nothing, not even a
ping, for 60 seconds is dropped.

### Lobby to client

`welcome` answers a good `join`:

```json
{"t": "welcome", "v": 1, "secret": "0123456789abcdef",
 "ice": {"stun": ["stun.cloudflare.com:3478"],
         "turn": {"servers": ["turn.cloudflare.com:3478"],
                  "username": "…", "credential": "…", "ttl": 3600}}}
```

- `secret`: the room's secret, 16 hex digits, lower case. It stays the same
  while anyone is in the room, and is new once the room has emptied.
- `ice.stun`: STUN servers as `host:port`.
- `ice.turn`: TURN over UDP, as `host:port`, with the credentials for all of
  them. Missing when the lobby has no TURN key, couldn't get credentials, or is
  keeping to its TURN budget (below), so players only try direct paths. `ttl`
  is in seconds.

`ice` answers `ice` with an `ice` object like the `welcome`'s:

```json
{"t": "ice", "ice": {"stun": ["stun.cloudflare.com:3478"], "turn": {…}}}
```

`peers` follows the `welcome` and is sent again to everyone whenever a player
joins, leaves or updates. It lists everyone else in the room:

```json
{"t": "peers", "peers": [{"mac": "001dd8010204", "title": "4D5307E6",
  "version": 123, "candidates": ["203.0.113.9:40000"], "relay": "198.51.100.7:50004"}]}
```

`reject` refuses a `join` (or a later bad message), and the lobby closes the
socket right after it:

```json
{"t": "reject", "reason": "full"}
```

| `reason` | Close code | When |
| --- | --- | --- |
| `bad_request` | 4000 | A message that isn't one of the above, a bad field, a `join` that isn't first, or no `join` within 10 seconds |
| `full` | 4001 | The room has 16 players |
| `duplicate_mac` | 4002 | Another live player in the room has the same `mac` |
| `version` | 4003 | `v` isn't 1 |

A player with the same `mac` whose socket is closed, or that has been silent
for 60 seconds, is dropped in favour of the new one.

## Who's online

`GET /v1/online` (or `HEAD`) counts the players in each title's public lobby.
Private rooms are never listed, and nothing else about the players is:

```json
{"v": 1, "titles": {"4D5307E6": 3, "4D530877": 1}, "private": 2, "here": 7}
```

- `titles`: title ID to players, the busiest 100 lobbies, none with 0.
- `private`: how many players are in private rooms, all together. A private
  room tells the directory its count by its Durable Object's ID, never its code
  or its players' titles.
- `here`: how many apps are open with Online features on, in the library or in
  a game. An app says so with `GET /v1/online?here=<id>` every 5 minutes, where
  `<id>` is 16 hex digits, lower case, that it makes up each launch; the
  directory counts each `<id>` for 6 minutes. An app going to the background
  or closing says so with `?gone=<id>`, and stops counting. Both requests are
  answered fresh.
- A room tells the directory (one Durable Object, `Directory`) its count when
  it changes and every 5 minutes while it has players; the directory forgets a
  room it hasn't heard from in 15 minutes.
- Each Worker instance reuses its answer for a minute and sends
  `Cache-Control: public, max-age=60`. Clients ask at most once a minute, so a
  count can be up to two minutes old.
- Other methods answer 405.

## TURN credentials

The Worker asks Cloudflare for credentials on each `join` and `ice`, with the secrets
`TURN_KEY_ID` and `TURN_KEY_API_TOKEN`:

    POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers
    Authorization: Bearer $TURN_KEY_API_TOKEN
    {"ttl": 3600}

It turns the `iceServers` it gets back into `ice`: `stun:` URLs into `stun`,
and `turn:` URLs over UDP (no `transport` parameter, or `transport=udp`) into
`turn.servers`. `turns:` and TCP URLs are left out. Without the secrets, or when
the request fails or takes over 3 seconds, `ice` has `stun` only, with
`stun.cloudflare.com:3478`.

### TURN budget

TURN is the only part Cloudflare bills for ($0.05 per GB sent to players past
the first 1,000 GB a month) and it has no spending cap, so one Durable Object,
`Turn`, hands out every credential and keeps to a budget:

- It reads the account's TURN egress over the last 31 days from the GraphQL
  Analytics API (`callsTurnUsageAdaptiveGroups`, with `CF_ACCOUNT_ID` and
  `CF_ANALYTICS_TOKEN`), at most every 2 minutes, and every 2 minutes while
  any credentials are live.
- At `TURN_CAP_GB` (400) or more, or when the usage can't be read or those
  secrets aren't set, it hands out STUN only and revokes the live credentials.
- At most `TURN_MAX_LIVE` (32) credentials are live at once, and at most
  `TURN_MAX_PER_IP` (4) to one address (`CF-Connecting-IP`; the object keeps a
  hash of it while the credentials are live). Past either, players get STUN
  only. Each credential is good for an hour; a player's are revoked when it
  leaves.
