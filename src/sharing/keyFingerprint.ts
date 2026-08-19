import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A short, human-shareable fingerprint of a sync public key — the trust anchor that
 * travels in the connect deep link / QR so the recipient does **not** have to trust
 * the server for the origin's key (PRD-sync-sharing §7, §9). Port of
 * `sync/sharing/KeyFingerprint.kt`.
 *
 * The fingerprint is `base64url(SHA-256(key))` without padding — URL-safe so it drops
 * straight into the `k=` link parameter with no escaping, and full-width (no
 * truncation) so it is collision-resistant: a malicious server that swaps the key in
 * `user/{uuid}` cannot produce one matching the out-of-band fingerprint.
 *
 * The same digest, regrouped into short blocks, is the basis of the Signal-style
 * **safety number** shown on the confirm screen for an at-a-glance human compare.
 */

/** `base64url(SHA-256(publicKey))`, the canonical link/QR fingerprint of `publicKey`. */
export function fingerprintOf(publicKey: Uint8Array): string {
  return sha256(publicKey).toString('base64url');
}

/** True when `publicKey` hashes to `fingerprint` — the TOFU key-pin check on an incoming link. */
export function fingerprintMatches(publicKey: Uint8Array, fingerprint: string): boolean {
  return constantTimeEquals(fingerprintOf(publicKey), fingerprint.trim());
}

/**
 * A grouped, human-comparable rendering of a key's fingerprint — five-character
 * lowercase blocks of the hex SHA-256, e.g. `a1b2c d3e4f …`. Printed beside the share
 * code so the user can compare it against what the app shows and defeat a key
 * substitution (there is no automated channel to trust).
 */
export function safetyNumber(publicKey: Uint8Array): string {
  const hex = sha256(publicKey).toString('hex');
  return (hex.match(/.{1,5}/g) ?? []).join(' ');
}

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Length-independent compare so a mismatch reveals nothing through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch rather than returning false, and the
  // lengths here are public (both are fixed-width digests), so the early exit leaks
  // nothing the caller did not already know.
  return left.length === right.length && timingSafeEqual(left, right);
}
