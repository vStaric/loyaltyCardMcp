import { createHmac } from 'node:crypto';
import { SEED_BYTES } from './bip39.js';

/**
 * Deterministically expands a BIP-39 seed into the secret material that defines a
 * peer's sync identity: an Ed25519 signing seed, an X25519 key-agreement seed, and
 * the account UUID. Ported byte-for-byte from `crypto/IdentityDeriver.kt`.
 *
 * Everything an identity is — including its public resource locator (`user/{uuid}`)
 * — descends from the one BIP-39 seed, so restoring the recovery phrase restores the
 * *whole* identity, UUID included. A random UUID would break that: you would recover
 * your keys but not know which server resources are yours.
 *
 * Derivation is HKDF-SHA512 (RFC 5869): one extract over the seed, then one expand
 * per output with a distinct, domain-separated `info` label so the three outputs are
 * independent.
 *
 * **This file is a drift risk.** Any change here mints a different account from the
 * same recovery phrase, so it is pinned by known-answer tests rather than by
 * round-trip tests alone: JVM-computed vectors in `test/identityDeriver.test.ts`, and
 * mnemonic → uuid → published public keys in `test-vectors/envelope-crypto.json`.
 */

/** HKDF salt — versioned so the derivation can be rotated without ambiguity. */
const HKDF_SALT = 'tolar-identity-v1';

const INFO_ED25519 = 'tolar/identity/ed25519-seed';
const INFO_X25519 = 'tolar/identity/x25519-seed';
const INFO_UUID = 'tolar/identity/uuid';

const SUB_SEED_BYTES = 32;
const UUID_BYTES = 16;
const HMAC = 'sha512';
const HMAC_LEN = 64;

/** The three secrets an identity derives from its seed. */
export interface DerivedSecrets {
  /** 32-byte seed for `crypto_sign` (Ed25519). */
  readonly ed25519Seed: Uint8Array;
  /** 32-byte seed for `crypto_box` (X25519). */
  readonly x25519Seed: Uint8Array;
  /** Canonical lowercase v4-shaped UUID string, the account's resource locator. */
  readonly uuid: string;
}

/** Expand a 64-byte BIP-39 `seed` into the identity's secrets. Deterministic. */
export function deriveIdentitySecrets(seed: Uint8Array): DerivedSecrets {
  if (seed.length !== SEED_BYTES) {
    throw new RangeError(`expected a ${SEED_BYTES}-byte BIP-39 seed, was ${seed.length}`);
  }
  const prk = hkdfExtract(Buffer.from(HKDF_SALT, 'utf8'), seed);
  return {
    ed25519Seed: hkdfExpand(prk, INFO_ED25519, SUB_SEED_BYTES),
    x25519Seed: hkdfExpand(prk, INFO_X25519, SUB_SEED_BYTES),
    uuid: uuidFrom(hkdfExpand(prk, INFO_UUID, UUID_BYTES)),
  };
}

/**
 * Format 16 derived bytes as a canonical RFC 4122 v4 UUID string. The version (4)
 * and variant (10xx) bits are forced so the value is a *well-formed* v4 UUID even
 * though it is deterministic rather than random — the server and other clients only
 * ever treat it as an opaque locator string.
 */
function uuidFrom(bytes: Uint8Array): string {
  const b = bytes.slice(0, UUID_BYTES);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  let out = '';
  for (let i = 0; i < UUID_BYTES; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += b[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** HKDF-Extract: `PRK = HMAC-SHA512(salt, IKM)`. */
function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac(HMAC, salt).update(ikm).digest());
}

/**
 * HKDF-Expand to `length` bytes (`length <= 255*HMAC_LEN`). Standard RFC 5869
 * `T(1)|T(2)|…` construction with a single-byte counter.
 */
function hkdfExpand(prk: Uint8Array, info: string, length: number): Uint8Array {
  if (length > 255 * HMAC_LEN) throw new RangeError(`HKDF length too large: ${length}`);
  const infoBytes = Buffer.from(info, 'utf8');
  const out = new Uint8Array(length);
  let previous = new Uint8Array(0);
  let generated = 0;
  let counter = 1;
  while (generated < length) {
    const mac = createHmac(HMAC, prk);
    mac.update(previous);
    mac.update(infoBytes);
    mac.update(Uint8Array.of(counter & 0xff));
    previous = new Uint8Array(mac.digest());
    const take = Math.min(previous.length, length - generated);
    out.set(previous.subarray(0, take), generated);
    generated += take;
    counter++;
  }
  return out;
}
