-- XeniOS diagnostics, D1 (SQLite). Raw rows (sessions, crashes, raw) are
-- deleted after 90 days; crash_groups, daily_title, title_names and
-- symbol_chunks are kept. The dashboard reads the raw rows (at most 90 days).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  build_id TEXT NOT NULL,
  official INTEGER NOT NULL,
  model TEXT NOT NULL,
  device_class TEXT NOT NULL,
  os TEXT,
  title_id TEXT,
  end_reason TEXT,
  duration_s INTEGER,
  active_s INTEGER,
  frames INTEGER,
  first_frame_ms INTEGER,         -- game start to its first frame
  median_fps REAL,
  low1_fps REAL,
  stutter_pct REAL,
  severe_frames INTEGER,
  long_frames INTEGER,
  long_frames_compiling INTEGER,
  pipelines_compiled INTEGER,     -- shader pipelines compiled in the session
  stored_pipelines INTEGER,       -- in the game's shader storage; 0: first run
  gpu_errors INTEGER,             -- command buffers the GPU failed
  thermal_nominal_s INTEGER,
  thermal_fair_s INTEGER,
  thermal_serious_s INTEGER,
  thermal_critical_s INTEGER,
  low_power_s INTEGER,
  peak_footprint_mb INTEGER,
  min_available_mb INTEGER,
  memory_warnings INTEGER,
  pacing TEXT NOT NULL,           -- guest refresh cap: capped, uncapped or mixed
  framerate_limit INTEGER,        -- the host presentation cap, 0 when off
  -- Frame interval histogram: guest frames up to 10, 15, 18.33, 25, 30,
  -- 36.67, 45, 55, 60, 73.33, 100, 250 ms and longer (lib.mjs
  -- INTERVAL_EDGES_MS); 15-18.33, 30-36.67, 45-55 and 60-73.33 are the bands
  -- around 60, 30, 20 and 15 fps.
  h0 INTEGER, h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER, h5 INTEGER, h6 INTEGER,
  h7 INTEGER, h8 INTEGER, h9 INTEGER, h10 INTEGER, h11 INTEGER, h12 INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_day ON sessions (day);
CREATE INDEX IF NOT EXISTS sessions_title ON sessions (title_id, day);

CREATE TABLE IF NOT EXISTS crashes (
  id TEXT PRIMARY KEY,            -- report id, or report id#n for MetricKit
  day TEXT NOT NULL,
  build_id TEXT NOT NULL,
  official INTEGER NOT NULL,
  model TEXT NOT NULL,
  device_class TEXT NOT NULL,
  os TEXT,
  title_id TEXT,
  source TEXT NOT NULL,           -- app, extension, metrickit
  launch_id TEXT,
  binary_uuid TEXT,
  kind TEXT,                      -- signal, exception type or fatal
  message TEXT,                   -- a fatal error's message or MetricKit's
                                  -- termination reason, redacted
  fault_address TEXT,             -- the address a fault touched
  frames TEXT NOT NULL,           -- JSON [{image, offset, symbol}]
  signature TEXT,                 -- NULL until the cron signs it
  duplicate_of TEXT               -- another report of the same launch
);
CREATE INDEX IF NOT EXISTS crashes_day ON crashes (day);
CREATE INDEX IF NOT EXISTS crashes_unsigned ON crashes (signature) WHERE signature IS NULL;
CREATE INDEX IF NOT EXISTS crashes_launch ON crashes (launch_id);
CREATE INDEX IF NOT EXISTS crashes_signature ON crashes (signature, day);

CREATE TABLE IF NOT EXISTS crash_groups (
  signature TEXT PRIMARY KEY,
  first_day TEXT NOT NULL,
  last_day TEXT NOT NULL,
  count INTEGER NOT NULL,         -- official builds, duplicates excluded
  builds TEXT NOT NULL,           -- JSON arrays, at most 20 entries each
  titles TEXT NOT NULL,
  models TEXT NOT NULL,
  issue_number INTEGER,
  issue_draft TEXT,               -- JSON {title, body} when not synced
  dirty INTEGER NOT NULL DEFAULT 1
);

-- Per day, build, title, chip and pacing; the history past 90 days.
CREATE TABLE IF NOT EXISTS daily_title (
  day TEXT NOT NULL,
  build_id TEXT NOT NULL,
  official INTEGER NOT NULL,
  title_id TEXT NOT NULL,         -- '' for sessions before a title was known
  device_class TEXT NOT NULL,
  pacing TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  unclean INTEGER NOT NULL,       -- crash, fatal or killed
  killed INTEGER NOT NULL,        -- killed in the foreground
  play_s INTEGER NOT NULL,
  hot_s INTEGER NOT NULL,         -- time at Serious or Critical
  long_frames INTEGER NOT NULL,
  long_frames_compiling INTEGER NOT NULL,
  gpu_error_sessions INTEGER NOT NULL,
  cold_sessions INTEGER NOT NULL,         -- first run: no stored pipelines
  cache_known_sessions INTEGER NOT NULL,  -- sessions that reported the cache
  median_fps REAL,                -- from the summed histogram
  low1_fps REAL,
  stutter_pct REAL,
  h0 INTEGER, h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER, h5 INTEGER, h6 INTEGER,
  h7 INTEGER, h8 INTEGER, h9 INTEGER, h10 INTEGER, h11 INTEGER, h12 INTEGER,
  PRIMARY KEY (day, build_id, official, title_id, device_class, pacing)
);

-- Game names from the compatibility list, for the title IDs seen. name is NULL
-- for one the list doesn't have; checked_day says when to look again.
CREATE TABLE IF NOT EXISTS title_names (
  title_id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,                    -- compatibility: playable, ingame, ...
  checked_day TEXT NOT NULL
);

-- Each cleaned record as stored, for replaying into the tables above after a
-- schema change (dev/rebuild.mjs).
CREATE TABLE IF NOT EXISTS raw (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  record TEXT NOT NULL            -- JSON, as cleanEnvelope left it
);
CREATE INDEX IF NOT EXISTS raw_day ON raw (day);

-- Release symbol maps (symbols.mjs), a few hundred symbols per row, so the
-- cron inflates only the rows a crash's frames fall in.
CREATE TABLE IF NOT EXISTS symbol_chunks (
  uuid TEXT NOT NULL,
  start INTEGER NOT NULL,         -- first symbol, as an offset from the load address
  data BLOB NOT NULL,             -- gzip: the map's header line, then this chunk's lines
  PRIMARY KEY (uuid, start)
);
