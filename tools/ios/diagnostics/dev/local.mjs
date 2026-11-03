// The Worker's bindings on the local fakes under DATA_DIR (d1.sqlite), for the
// dev server and the dev scripts. Nothing here talks to the network:
// DATA_DIR/compat-data.json, when present, stands in for the compatibility
// list (https://xenios.jp/compatibility/search-index.json, or data.json) and
// every other fetch fails.

import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeD1, allowAll} from './fakes.mjs';
import {runCron} from '../worker/index.mjs';

export const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

export function localEnv(dataDir, extra = {}) {
  mkdirSync(dataDir, {recursive: true});
  return {
    DB: fakeD1(join(dataDir, 'd1.sqlite'), SCHEMA),
    LIMITER: allowAll,
    ATTESTATION_KEY: process.env.ATTESTATION_KEY ?? '',
    DASHBOARD_LABEL: process.env.DASHBOARD_LABEL ?? '',
    // The dev server listens on 127.0.0.1 only; deployed, Access guards these.
    DASHBOARD_ACCESS: 'open',
    ...extra,
  };
}

export function localFetch(dataDir) {
  const compat = join(dataDir, 'compat-data.json');
  return async (url) => {
    if (/\/compatibility\/(search-index|data)\.json$/.test(String(url)) && existsSync(compat)) {
      return new Response(readFileSync(compat), {headers: {'Content-Type': 'application/json'}});
    }
    return new Response('offline', {status: 503});
  };
}

// Runs the cron without its query budget until no crash is left unsigned (the
// dev scripts, which may add hundreds at once).
export async function runCronUntilSigned(env, dataDir, now = new Date()) {
  const unsigned = 'SELECT COUNT(*) AS n FROM crashes WHERE signature IS NULL';
  do {
    await runCron(env, now, localFetch(dataDir), Infinity);
  } while ((await env.DB.prepare(unsigned).first()).n > 0);
}
