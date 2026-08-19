import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { BIP39_ENGLISH } from './bip39Wordlist.js';

/**
 * BIP-39 mnemonic codec — the **exportable source of truth** for this agent's sync
 * identity, ported from the Android app's `crypto/Bip39.kt`.
 *
 * The recovery model (PRD-sync-sharing §4, §8) is deliberately pure: the peer holds
 * a single secret — the BIP-39 entropy — and every key and the account UUID are
 * *derived* from the seed it produces ({@link deriveIdentitySecrets}). Writing the
 * twelve/twenty-four words down is therefore a complete backup.
 *
 * ## Encoding (BIP-39)
 * - Entropy is 128–256 bits, a multiple of 32. `CS = ENT/32` checksum bits are taken
 *   from the high bits of `SHA-256(entropy)`; `(ENT+CS)` bits split into 11-bit groups
 *   index the 2048-word list → `(ENT+CS)/11` words.
 * - The seed is `PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048, 512)`.
 *   Both inputs are NFKD-normalised UTF-8 per the spec.
 */

/** Default entropy strength: 128 bits → a 12-word mnemonic. */
export const DEFAULT_ENTROPY_BITS = 128;

/** PBKDF2 iteration count fixed by BIP-39. */
const PBKDF2_ITERATIONS = 2048;

/** Seed length BIP-39 produces: 512 bits. */
export const SEED_BYTES = 64;

/** Reverse index `word -> position`, for decoding a mnemonic back to entropy. */
const WORD_INDEX: ReadonlyMap<string, number> = new Map(BIP39_ENGLISH.map((w, i) => [w, i]));

/**
 * Generate a fresh mnemonic from `strengthBits` of cryptographically secure entropy.
 * `strengthBits` must be a multiple of 32 in `128..256`.
 */
export function generateMnemonic(strengthBits: number = DEFAULT_ENTROPY_BITS): string {
  if (strengthBits < 128 || strengthBits > 256 || strengthBits % 32 !== 0) {
    throw new RangeError(
      `entropy strength must be 128..256 bits and a multiple of 32, was ${strengthBits}`,
    );
  }
  return entropyToMnemonic(randomBytes(strengthBits / 8));
}

/**
 * Encode `entropy` (16–32 bytes, a multiple of 4) as a space-joined mnemonic with
 * the BIP-39 checksum appended.
 */
export function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length < 16 || entropy.length > 32 || entropy.length % 4 !== 0) {
    throw new RangeError(`entropy must be 16..32 bytes and a multiple of 4, was ${entropy.length}`);
  }
  const entBits = entropy.length * 8;
  const checksumBits = entBits / 32;
  const hashFirstByte = sha256(entropy)[0]!;

  // Walk the concatenated (entropy || checksum) bit-stream 11 bits at a time.
  const totalBits = entBits + checksumBits;
  const result: string[] = [];
  let index = 0;
  let bitsInIndex = 0;
  for (let bitPos = 0; bitPos < totalBits; bitPos++) {
    const bit =
      bitPos < entBits
        ? (entropy[bitPos >>> 3]! >>> (7 - (bitPos % 8))) & 1
        : (hashFirstByte >>> (7 - (bitPos - entBits))) & 1;
    index = (index << 1) | bit;
    if (++bitsInIndex === 11) {
      result.push(BIP39_ENGLISH[index]!);
      index = 0;
      bitsInIndex = 0;
    }
  }
  return result.join(' ');
}

/**
 * Decode a mnemonic back to its raw entropy, validating the checksum and that every
 * word is in the list. Throws on any malformed or tampered mnemonic — used by the
 * "import recovery phrase" path.
 */
export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  const tokens = normalize(mnemonic)
    .split(' ')
    .filter((t) => t.length > 0);
  if (tokens.length < 12 || tokens.length > 24 || tokens.length % 3 !== 0) {
    throw new RangeError(`mnemonic must be 12..24 words and a multiple of 3, was ${tokens.length}`);
  }
  const totalBits = tokens.length * 11;
  const checksumBits = Math.floor(totalBits / 33);
  const entBits = totalBits - checksumBits;
  if (entBits % 8 !== 0) throw new RangeError('invalid mnemonic length');

  const bits = new Array<boolean>(totalBits);
  tokens.forEach((token, wordPos) => {
    const idx = WORD_INDEX.get(token);
    if (idx === undefined) throw new RangeError(`word not in BIP-39 list: ${token}`);
    for (let b = 0; b < 11; b++) {
      bits[wordPos * 11 + b] = ((idx >>> (10 - b)) & 1) === 1;
    }
  });

  const entropy = new Uint8Array(entBits / 8);
  for (let i = 0; i < entBits; i++) {
    if (bits[i]) entropy[i >>> 3]! |= 1 << (7 - (i % 8));
  }

  // Recompute and compare the checksum bits.
  const hashFirstByte = sha256(entropy)[0]!;
  for (let i = 0; i < checksumBits; i++) {
    const expected = ((hashFirstByte >>> (7 - i)) & 1) === 1;
    if (bits[entBits + i] !== expected) throw new RangeError('mnemonic checksum mismatch');
  }
  return entropy;
}

/** True if `mnemonic` is well-formed with a valid checksum. */
export function isValidMnemonic(mnemonic: string): boolean {
  try {
    mnemonicToEntropy(mnemonic);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the 64-byte BIP-39 seed from a `mnemonic` and optional `passphrase` (the
 * "25th word"). The mnemonic is **not** re-validated here — callers that accept user
 * input should run {@link isValidMnemonic} first.
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  const normalizedMnemonic = normalize(mnemonic);
  const salt = normalize(`mnemonic${passphrase}`);
  return new Uint8Array(
    pbkdf2Sync(
      Buffer.from(normalizedMnemonic, 'utf8'),
      Buffer.from(salt, 'utf8'),
      PBKDF2_ITERATIONS,
      SEED_BYTES,
      'sha512',
    ),
  );
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/** NFKD normalisation + whitespace collapse, exactly as BIP-39 requires. */
function normalize(s: string): string {
  return s.trim().normalize('NFKD').replace(/\s+/g, ' ');
}
