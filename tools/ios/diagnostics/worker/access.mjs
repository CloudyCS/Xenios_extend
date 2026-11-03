// Cloudflare Access for the dashboard and its data. The edge lets a request
// through only after sign-in and adds a signed JWT for the application; it is
// checked here as well, so a route that bypasses Access (workers.dev, a
// misconfigured path) can't serve the dashboard to anyone who sets the header.
//
// Vars: ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com) and ACCESS_AUD
// (the application's audience tag). Keys come from the team's certs endpoint.

const KEYS_TTL_MS = 60 * 60 * 1000;
// An unknown key ID refetches the keys at most this often.
const REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

let cache = {team: null, fetched: 0, keys: new Map()};

function base64urlBytes(text) {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function decodeJson(part) {
  return JSON.parse(new TextDecoder().decode(base64urlBytes(part)));
}

async function signingKey(team, kid, fetchImpl, now) {
  const stale = cache.team !== team || now - cache.fetched > KEYS_TTL_MS;
  if (stale || (!cache.keys.has(kid) && now - cache.fetched > REFETCH_MS)) {
    const response = await fetchImpl(`${team}/cdn-cgi/access/certs`);
    if (!response.ok) return null;
    const keys = new Map();
    for (const jwk of (await response.json()).keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      keys.set(jwk.kid, await crypto.subtle.importKey(
          'jwk', {kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true},
          {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']));
    }
    cache = {team, fetched: now, keys};
  }
  return cache.keys.get(kid) ?? null;
}

export async function verifyAccess(request, env, fetchImpl = fetch, now = Date.now()) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
  if (!token || !team || !env.ACCESS_AUD) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = decodeJson(parts[0]);
    const claims = decodeJson(parts[1]);
    if (header.alg !== 'RS256') return false;
    const key = await signingKey(team, header.kid, fetchImpl, now);
    if (!key) return false;
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64urlBytes(parts[2]), signed)) {
      return false;
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const seconds = now / 1000;
    return audiences.includes(env.ACCESS_AUD) && claims.iss === team &&
           Number(claims.exp) > seconds - CLOCK_SKEW_S &&
           !(Number(claims.nbf) > seconds + CLOCK_SKEW_S);
  } catch {
    return false;
  }
}

// Tests start from an empty key cache.
export function resetAccessKeys() {
  cache = {team: null, fetched: 0, keys: new Map()};
}
