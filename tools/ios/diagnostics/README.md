# XeniOS diagnostics

Anonymous crash reports and performance statistics from the iOS app, and the
Cloudflare Worker that receives, groups and shows them. The app sends nothing
unless Online Features and Share Diagnostics are both on (Settings > About) and
the build carries an endpoint (`XeniOSDiagnosticsURL`).

## What the app sends

One JSON record per POST to `/v1/diag`, gzip-compressed:
`{schema: 1, kind, id, build, device, body}`. Records carry no time; the
Worker stores the day it received them.

| kind | when | body |
| --- | --- | --- |
| `session` | a game stops, or at the next launch for one that didn't | a histogram of guest frame times in bands around 60, 30, 20 and 15 fps, long frames (over 50 ms) and how many fell during shader compiles, time to the first frame, pipelines compiled and stored, GPU command failures, whether the guest refresh cap was on (`guestRefreshCap`: capped, uncapped or mixed) and the frame rate limit, time per thermal state, Low Power Mode time, peak memory footprint, lowest available memory, memory warnings, how it ended |
| `crash` | the next launch after a fault Xenia didn't handle or a fatal error; on iOS 27 also from the crash reporter extension; MetricKit's crash reports at the next launch | signal, fault address, frames as image + offset (`XeniOS`, `<jit>` or `system`), title ID, the fatal error's message or MetricKit's termination reason (redacted) |

A crash record's launch ID ties the app's, the extension's and MetricKit's
reports of one launch together; a session record has none. MetricKit's reports
are cut down to the crashed thread (64 frames) and sent only when the app knows
diagnostics were on during that launch (a short launch log in the app's
defaults, cleared when Share Diagnostics goes off).

`build` holds the version, build number, channel, commit, the release
attestation and the executable's UUID; `device` the model identifier and iOS
version. Nothing holds a file name, path, account, e-mail address or location:
the app redacts paths, game file names, quoted text and e-mail addresses before
queuing, and the Worker keeps only the fields it knows, checks each one's type
and range, and scrubs free text again. Records wait in
`Library/Application Support/XeniOS/Outbox` (at most 50, 2 MB, 14 days, not
backed up) and are sent 15 s after launch and when a game stops, never during
play, and not on constrained networks. Settings > About > Pending Reports shows
them as they will be sent. Turning either switch off deletes them. Turning off
Share Diagnostics, or choosing Don't Send Diagnostics in the first-launch
notice, leaves Online Features on (System Link over the internet included).
A build without an endpoint shows no Share Diagnostics switch and its notices
don't mention diagnostics.

The Worker uses the client IP address only for the per-IP rate limit and never
stores it: not in D1 or Workers Logs (`[observability] enabled = false`).
The privacy page (https://xenios.jp/privacy#app-diagnostics) says so: "The
server doesn't store your IP address; it uses it only to limit how often
reports can be sent." Cloudflare still handles the connection.

App sources: `src/xenia/ui/ios/shared/ios_diagnostics*.{h,mm}`,
`ios_session_stats`, `ios_fault_record`, `ios_crash_reporting`,
`ios_crash_context.h`, `ios_state_reporting`, and the extension in
`src/xenia/ui/ios/crash_reporter/`.

## Server

- `worker/index.mjs`: ingest (64 KB compressed and 256 KB inflated, checked as
  the body streams in; per-IP rate limit; attestation check: only builds
  attested for that build ID count as official), the routes and the cron.
- `worker/access.mjs`: checks the Cloudflare Access token on the dashboard and
  `/v1/stats/*` (signature, audience, issuer, expiry). Without
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` those routes answer 403.
- `worker/stats.mjs`: the dashboard's data, `/v1/stats/<view>`.
- `worker/dashboard.mjs`: the dashboard page, served at `/`.
- `worker/lib.mjs`: the per-field allowlists, scrubbing, session statistics,
  symbolication, crash signatures, issue drafts. No bindings, so Node tests it
  directly.
- `schema.sql`: D1 tables. Raw rows (`sessions`, `crashes` and each record's
  raw copy in `raw`) go after 90 days; `crash_groups`, `daily_title`,
  `title_names` and the release symbol maps (`symbol_chunks`) stay.
- `symbols.mjs`: a release's symbol map as `symbol_chunks` rows.
- `wrangler.toml.example`: bindings, secrets, cron.

It all fits the Workers Free plan, which stops at its limits instead of
billing: D1 only (no R2), and each cron run makes at most 45 subrequests (D1
queries and fetches; the plan allows 50) and leaves the rest of a backlog to
the next run, about ten crashes a run. Symbol maps are stored in chunks of 512
symbols, so a crash costs a few kilobytes to inflate, not the 5 MB map, and
game names come from a scan of the compatibility list for the new title IDs
only; both keep a run inside the plan's 10 ms of CPU.

The cron symbolicates frames with the build's symbol map, signs each crash with
its top three XeniOS frames (a fatal error without them by its message; signal
numbers become names, so the app's, the extension's and MetricKit's reports of
one crash sign alike), keeps one report per launch (the extension's, then the
app's, then MetricKit's), rolls sessions up per day, build, title, chip and
refresh cap, looks up names for new title IDs in the compatibility list
(`COMPAT_DATA_URL`, by default https://xenios.jp/compatibility/search-index.json,
whose status is each game's on its main platform, iOS for most), and
opens or updates one issue per crash group in a private GitHub repository when
`GITHUB_TOKEN` is set (a group needs two reports; at most five new issues and
20 updates a run). Each step runs whatever happened to the ones before, and a
crash that can't be signed is set aside as `<unsigned>`.

## Dashboard

`/` (behind Cloudflare Access) shows the last 7, 30 or 90 days, for official
builds or with self-built ones, and for one build or chip if chosen. Everything
is in the page itself; charts are inline SVG with tooltips and a table view.

- Overview: crash-free sessions, sessions, play time, crash reports, kills in
  the foreground and time running hot, each against the previous period; daily
  crash-free sessions and sessions by how they ended; top crashes and games.
- Games: per game, frame rate (median and 1 % low), stutter (time in frames at
  least 1.5 times the median), hitches (frames over 50 ms) and the share during
  shader compiles, time to the first frame and sessions with GPU errors, from
  capped play. A game's page adds its frame pacing (capped and uncapped), frame
  rate per day, chips, builds, how sessions ended, display settings, memory,
  startup and shaders (first frame, pipelines compiled, first runs without
  stored shaders and their hitches against later runs), and crashes.
- Crashes: sessions that ended badly per day, crash groups with a daily
  sparkline. A group's page shows the latest report's frames, fault address and
  message (a fatal error's, or MetricKit's termination reason) and its builds,
  games, devices, iOS versions and sources.
- Devices: per chip, crash-free sessions, kills, thermal state, memory
  footprint and warnings, Low Power Mode; models and iOS versions.
- Builds: each build's crash-free sessions, crash reports, frame rate, time to
  the first frame and GPU errors.

Frame statistics come from summed frame time histograms, so they weigh every
frame played, not every session. Each band stands for one rate (the 30 fps band
for 30.0), so a game locked at 30 reads 30.0 and a regression shows as a step. A session is one game from start to stop.
The views read the raw rows, so the range stops at 90 days; `daily_title` keeps
the per-day history beyond that.

Symbol maps: `tools/build_apple_release.sh` writes `OUT/symbols/<UUID>.map.gz`
(`tools/ios/make_symbol_map.sh`). Upload it with each release:
`node symbols.mjs OUT/symbols/*.map.gz > symbols.sql`, then
`wrangler d1 execute xenios-diagnostics --remote --file symbols.sql`.

## Local testing

Nothing here needs a Cloudflare account.

```
cd tools/ios/diagnostics
node --test test/                       # lib, Worker and dashboard tests on SQLite and in-memory fakes
node dev/server.mjs DIR 8787           # the Worker on 127.0.0.1, dashboard open; POST /__cron runs the cron
client-harness/run.sh OUT_DIR           # the app's diagnostics code on the Mac against it
node dev/synthetic.mjs DIR [MAP.map.gz] # a made-up month of records in an empty DIR
node dev/rebuild.mjs DIR                # D1 again from its raw copies (after a schema change)
```

`DATA_DIR/compat-data.json`, when present, stands in for the compatibility list,
so the dev server fetches nothing. To look at the dashboard with something in it,
fill a directory with `dev/synthetic.mjs` and serve it with
`DASHBOARD_LABEL="Synthetic data"`, which badges the page: none of that data
comes from players.

The client harness builds the real outbox, session statistics, fault record and
switch code with small shims, drives them (fault, sessions, redaction, backoff,
upload, switches), uploads to the dev server and checks the stored rows. It uses
a throwaway home directory and port 8788. Node 22.5 or later (`node:sqlite`).

## Deploying

1. `wrangler d1 create xenios-diagnostics`, fill in `wrangler.toml` from the
   example, apply `schema.sql` (`wrangler d1 execute xenios-diagnostics
   --remote --file schema.sql`).
2. `wrangler secret put ATTESTATION_KEY` with the key release builds are
   signed with (`build_apple_release.sh --attestation-key-file`), and
   `GITHUB_TOKEN` if wanted.
3. `wrangler deploy`. The endpoint is
   `https://xenios-diagnostics.<subdomain>.workers.dev/v1/diag`.
4. For the dashboard, Cloudflare Access on the workers.dev route (leave
   `/v1/diag` public) and its team domain and audience tag in
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Until then it answers 403.
5. Build releases with `--diagnostics-url <endpoint>` and upload their symbol
   maps.
