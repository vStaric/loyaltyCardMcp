import { describe, expect, it } from 'vitest';
import {
  SIG_HEADER_SIG,
  SIG_HEADER_UUID,
  SIG_HEADER_VER,
  RequestSigner,
  canonicalMessage,
  sha256Hex,
} from '../src/sync/requestSigner.js';
import { initSodium } from '../src/crypto/sodium.js';

/**
 * Pins the per-request canonical signing string byte-for-byte against the backend's
 * `auth/Signature.kt#canonicalMessage` and the app's `CanonicalMessageTest`. The
 * implementations must never drift — a mismatch silently breaks every signed write —
 * so the expected strings here are the contract, including the known-answer SHA-256
 * body hashes.
 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

describe('canonical message', () => {
  it('matches the known-answer sha256 vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY_SHA256);
    expect(sha256Hex(utf8('hello'))).toBe(HELLO_SHA256);
  });

  it('pins method, path, ver and body hash for a PUT', () => {
    expect(text(canonicalMessage('put', '/api/user/abc', 7, utf8('hello')))).toBe(
      `PUT\n/api/user/abc\n7\n${HELLO_SHA256}`,
    );
  });

  it('hashes the empty body for a signed GET', () => {
    expect(
      text(canonicalMessage('GET', '/api/requestShare/origin-uuid', 0, new Uint8Array(0))),
    ).toBe(`GET\n/api/requestShare/origin-uuid\n0\n${EMPTY_SHA256}`);
  });

  it('refuses a ver the server would recompute differently', () => {
    expect(() => canonicalMessage('GET', '/api/user/abc', 1.5, new Uint8Array(0))).toThrow(
      RangeError,
    );
  });
});

describe('RequestSigner', () => {
  it('produces headers a verifier can check against the canonical message', async () => {
    const sodium = await initSodium();
    const keys = sodium.ed25519KeyPairFromSeed(new Uint8Array(32).fill(9));
    const signer = new RequestSigner('acct-uuid', keys.secretKey, sodium);

    const body = utf8('{"signKey":"x"}');
    const headers = signer.headers('PUT', '/api/user/acct-uuid', 4, body);

    expect(headers[SIG_HEADER_UUID]).toBe('acct-uuid');
    expect(headers[SIG_HEADER_VER]).toBe('4');
    const sig = new Uint8Array(Buffer.from(headers[SIG_HEADER_SIG]!, 'base64'));
    expect(sig).toHaveLength(64);
    expect(
      sodium.verifyDetached(
        canonicalMessage('PUT', '/api/user/acct-uuid', 4, body),
        sig,
        keys.publicKey,
      ),
    ).toBe(true);
    // The signature is bound to the version, so replaying it at another one must fail.
    expect(
      sodium.verifyDetached(
        canonicalMessage('PUT', '/api/user/acct-uuid', 5, body),
        sig,
        keys.publicKey,
      ),
    ).toBe(false);
  });
});
