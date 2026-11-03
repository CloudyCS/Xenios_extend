import {createHmac} from 'node:crypto';

export const KEY = 'test-key-not-a-real-secret';

// The release script's attestation signature: HMAC-SHA256, base64url.
export function sign(payload, key = KEY) {
  return createHmac('sha256', key).update(payload).digest('base64')
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
