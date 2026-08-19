import { describe, expect, it } from 'vitest';
import {
  SEED_BYTES,
  entropyToMnemonic,
  generateMnemonic,
  isValidMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
} from '../src/crypto/bip39.js';

/**
 * Pins the BIP-39 codec against the canonical Trezor English test vectors (entropy →
 * mnemonic → seed, passphrase "TREZOR") — the same vectors the Android app's
 * `Bip39Test` pins.
 *
 * A regression here breaks recovery-phrase compatibility with every other BIP-39
 * implementation, and — because the account uuid descends from the seed — silently
 * points this peer at a different account.
 */
const VECTORS = [
  {
    entropy: '00000000000000000000000000000000',
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon about',
    seed:
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553' +
      '1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
  },
  {
    entropy: 'ffffffffffffffffffffffffffffffff',
    mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
    seed:
      'ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13' +
      '332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069',
  },
  {
    entropy: '0000000000000000000000000000000000000000000000000000000000000000',
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon abandon art',
    seed:
      'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd30971' +
      '70af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8',
  },
] as const;

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('bip39', () => {
  it('encodes entropy to the canonical mnemonic', () => {
    for (const v of VECTORS) expect(entropyToMnemonic(hex(v.entropy))).toBe(v.mnemonic);
  });

  it('decodes a mnemonic back to its entropy', () => {
    for (const v of VECTORS) expect(toHex(mnemonicToEntropy(v.mnemonic))).toBe(v.entropy);
  });

  it('derives the canonical seed', () => {
    for (const v of VECTORS) expect(toHex(mnemonicToSeed(v.mnemonic, 'TREZOR'))).toBe(v.seed);
  });

  it('produces a 64-byte seed that the passphrase changes', () => {
    const { mnemonic } = VECTORS[0];
    const withPass = mnemonicToSeed(mnemonic, 'TREZOR');
    const noPass = mnemonicToSeed(mnemonic);
    expect(withPass.length).toBe(SEED_BYTES);
    expect(noPass.length).toBe(SEED_BYTES);
    expect(toHex(withPass)).not.toBe(toHex(noPass));
  });

  it('generates a valid 12-word mnemonic that round-trips', () => {
    const mnemonic = generateMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(mnemonic)).toBe(true);
    expect(entropyToMnemonic(mnemonicToEntropy(mnemonic))).toBe(mnemonic);
  });

  it('generates 24 words at 256 bits and rejects an off-spec strength', () => {
    expect(generateMnemonic(256).split(' ')).toHaveLength(24);
    expect(() => generateMnemonic(130)).toThrow(RangeError);
    expect(() => generateMnemonic(64)).toThrow(RangeError);
  });

  it('rejects a corrupted checksum', () => {
    const tampered =
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon';
    expect(isValidMnemonic(tampered)).toBe(false);
    expect(() => mnemonicToEntropy(tampered)).toThrow(/checksum/);
  });

  it('rejects an unknown word', () => {
    const bogus =
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon zzzzzz';
    expect(isValidMnemonic(bogus)).toBe(false);
  });

  it('tolerates stray whitespace when normalising', () => {
    const messy =
      '  abandon   abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon about  ';
    expect(toHex(mnemonicToEntropy(messy))).toBe(VECTORS[0].entropy);
  });

  it('rejects entropy that is not 16..32 bytes and a multiple of 4', () => {
    expect(() => entropyToMnemonic(new Uint8Array(15))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(18))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(36))).toThrow(RangeError);
  });
});
