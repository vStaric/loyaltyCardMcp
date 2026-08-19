import { describe, expect, it } from 'vitest';
import { mnemonicToSeed } from '../src/crypto/bip39.js';
import { deriveIdentitySecrets } from '../src/crypto/identityDeriver.js';

/**
 * Pins seed → (ed25519 seed, x25519 seed, uuid) against **known answers computed on
 * the JVM**, using the same `javax.crypto` HMAC-SHA512 the Android app's
 * `IdentityDeriver` runs on.
 *
 * Round-trip and determinism tests cannot catch the failure that matters here. If this
 * expansion drifts from the app's by one byte, nothing throws: the peer derives a
 * perfectly valid identity for a *different account*, publishes a user row nobody
 * shared with, and every read comes back "no wrapped key for recipient". The account
 * uuid is the only resource locator there is, so these hex strings are the contract.
 */
const JVM_VECTORS = [
  {
    label: 'seed bytes 0..63 (the app IdentityDeriverTest seedA)',
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    ed25519Seed: '5984adfe333f61e138898ffb1ff3c0a81d822a98cf2005c0dcc29a63546f1c19',
    x25519Seed: 'f3037a550bcb0ab4d11d0898cf96e3952de9b8de3ca2b782489f2f790c626b70',
    uuid: '68c14920-e6b4-489e-b848-dfc19bf4164b',
  },
  {
    label: 'seed bytes 255-3i',
    seed: Uint8Array.from({ length: 64 }, (_, i) => (255 - i * 3) & 0xff),
    ed25519Seed: 'c1b7d33c96d0982ca87ddd087e218a1b0f17bce6249ffe3310784fc8cf1ea112',
    x25519Seed: 'd7b28a58c7438403f22b268e027ae25a6774f580172fcddfde550ad0e368390d',
    uuid: '2ac98d60-e133-4686-8058-d5abf5ec4604',
  },
] as const;

/**
 * The end-to-end one: a mnemonic every BIP-39 implementation agrees on, all the way
 * through to the account uuid. This is the string a user would type to move an
 * identity between hosts, so it is the vector that would betray a break in either half.
 */
const TREZOR_ZERO_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon about';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('identity derivation', () => {
  it('matches the JVM known answers', () => {
    for (const v of JVM_VECTORS) {
      const secrets = deriveIdentitySecrets(v.seed);
      expect(toHex(secrets.ed25519Seed), v.label).toBe(v.ed25519Seed);
      expect(toHex(secrets.x25519Seed), v.label).toBe(v.x25519Seed);
      expect(secrets.uuid, v.label).toBe(v.uuid);
    }
  });

  it('carries a canonical mnemonic through to the JVM-computed account uuid', () => {
    const secrets = deriveIdentitySecrets(mnemonicToSeed(TREZOR_ZERO_MNEMONIC));
    expect(toHex(secrets.ed25519Seed)).toBe(
      '718221357cf387576e4f3de08314cc3e536ce2d4a6fdf7e3518e363f0bf02e26',
    );
    expect(toHex(secrets.x25519Seed)).toBe(
      '61f3ff1f6fc288ce42674e3844042358b6e88a9241b4b679d579c5f7a04b36e1',
    );
    expect(secrets.uuid).toBe('220e05b1-548d-41f9-9d2d-0fe9fe258b88');
  });

  it('is deterministic', () => {
    const seed = JVM_VECTORS[0].seed;
    expect(deriveIdentitySecrets(seed)).toEqual(deriveIdentitySecrets(seed));
  });

  it('gives different seeds different identities', () => {
    const a = deriveIdentitySecrets(Uint8Array.from({ length: 64 }, (_, i) => i));
    const b = deriveIdentitySecrets(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
    expect(toHex(a.ed25519Seed)).not.toBe(toHex(b.ed25519Seed));
    expect(toHex(a.x25519Seed)).not.toBe(toHex(b.x25519Seed));
    expect(a.uuid).not.toBe(b.uuid);
  });

  it('domain-separates the two sub-seeds', () => {
    const s = deriveIdentitySecrets(JVM_VECTORS[0].seed);
    expect(s.ed25519Seed).toHaveLength(32);
    expect(s.x25519Seed).toHaveLength(32);
    expect(toHex(s.ed25519Seed)).not.toBe(toHex(s.x25519Seed));
  });

  it('emits a well-formed v4 uuid', () => {
    for (const v of JVM_VECTORS) {
      expect(v.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('rejects a seed that is not 64 bytes', () => {
    expect(() => deriveIdentitySecrets(new Uint8Array(32))).toThrow(RangeError);
    expect(() => deriveIdentitySecrets(new Uint8Array(65))).toThrow(RangeError);
  });
});
