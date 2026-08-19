import { describe, expect, it } from 'vitest';
import { ENVELOPE_SIGNING_DOMAIN, envelopeSignedBytes } from '../src/crypto/envelope.js';

/**
 * The byte-for-byte cross-check that keeps this client's `signed_bytes` in lockstep
 * with the server's `auth/EnvelopeSignature.kt` and the Android client's
 * `EnvelopeSigning`. The vectors below are the **exact** ones the backend's
 * `EnvelopeSignatureTest` and the app's `EnvelopeSigningTest` pin — the same resource
 * types, UUIDs, versions, base64 fields and recipient ordering.
 *
 * A drift here does not fail loudly at the seam: it produces envelopes the server
 * rejects with `bad_signature`, which reads like a key problem.
 */
const AUTHOR = '11111111-1111-1111-1111-111111111111';
const RECIPIENT_A = '22222222-2222-2222-2222-222222222222';
const RECIPIENT_B = '33333333-3333-3333-3333-333333333333';

const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');

describe('envelope signed bytes', () => {
  it('has the exact documented layout with no recipients', () => {
    const bytes = envelopeSignedBytes(
      'cards',
      AUTHOR,
      7,
      { iv: 'IVIV', ciphertext: 'CTCT', tag: 'TAGTAG' },
      {},
    );
    expect(text(bytes)).toBe(`tolar-env-v1\ncards\n${AUTHOR}\n7\nIVIV\nCTCT\nTAGTAG\n`);
  });

  it('appends recipients sorted by uuid ascending', () => {
    // Supplied out of order; the canonical form must sort B after A.
    const bytes = envelopeSignedBytes(
      'shoppinglist',
      'list::author',
      3,
      { iv: 'iv', ciphertext: 'ct', tag: 'tag' },
      { [RECIPIENT_B]: 'WRAPB', [RECIPIENT_A]: 'WRAPA' },
    );
    expect(text(bytes)).toBe(
      'tolar-env-v1\nshoppinglist\nlist::author\n3\niv\nct\ntag\n' +
        `${RECIPIENT_A}=WRAPA\n${RECIPIENT_B}=WRAPB\n`,
    );
  });

  it('uses the domain prefix the server constant declares', () => {
    expect(ENVELOPE_SIGNING_DOMAIN).toBe('tolar-env-v1');
  });

  it('refuses a ver that would not render as a JVM Long', () => {
    // `7.5` or `1e21` would stringify to something the server never recomputes, so the
    // signature would verify nowhere and the cause would be invisible.
    const data = { iv: 'iv', ciphertext: 'ct', tag: 'tag' };
    expect(() => envelopeSignedBytes('cards', AUTHOR, 7.5, data, {})).toThrow(RangeError);
    expect(() => envelopeSignedBytes('cards', AUTHOR, 1e21, data, {})).toThrow(RangeError);
  });
});
