import { createRequire } from 'node:module';
import type _sodiumTypes from 'libsodium-wrappers';

/**
 * libsodium-wrappers ships a broken ESM entry point: its `.mjs` does
 * `import "./libsodium.mjs"`, a sibling file the package does not publish, so a plain
 * `import` of it fails to resolve at run time. Its CommonJS build is fine, so this
 * package stays ESM and reaches for the working half explicitly.
 */
const _sodium = createRequire(import.meta.url)('libsodium-wrappers') as typeof _sodiumTypes;

/**
 * The libsodium primitives the sync layer needs, as a narrow facade over raw byte
 * arrays — the port of the app's `crypto/SodiumCrypto.kt`.
 *
 * The app binds libsodium through lazysodium/JNA; this side binds the *same*
 * libsodium through its WASM build, which is the point: `crypto_box_seal`'s
 * ephemeral-key construction and the XChaCha20-Poly1305 AEAD are not things a
 * second hand-rolled implementation should try to match.
 *
 * Algorithms (fixed by the backend contract in `loyaltyCardBe/docs/signing.md` and
 * PRD-sync-sharing §5):
 * - **Ed25519** detached signatures — raw 32-byte public key, 64-byte signature.
 * - **X25519 sealed box** (`crypto_box_seal`) — anonymous per-recipient wrapping of
 *   the content key; only the recipient's public key is needed to wrap.
 * - **XChaCha20-Poly1305-IETF** AEAD — random 256-bit content key, 192-bit nonce.
 */

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SECRET_KEY_BYTES = 64;
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_SEED_BYTES = 32;

export const X25519_PUBLIC_KEY_BYTES = 32;
export const X25519_SECRET_KEY_BYTES = 32;
export const X25519_SEED_BYTES = 32;
export const SEAL_OVERHEAD_BYTES = 48;

export const AEAD_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 24;
export const AEAD_TAG_BYTES = 16;

/**
 * A raw asymmetric keypair as libsodium represents it. For Ed25519 the secret key is
 * 64 bytes (libsodium's `crypto_sign` secret key, which embeds the public key); for
 * X25519 both halves are 32 bytes.
 */
export interface SodiumKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** A crypto primitive failed (bad tag, wrong key length, native error). */
export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

export interface SodiumCrypto {
  // --- Ed25519 (signing) ----------------------------------------------------

  /** Deterministically derive an Ed25519 keypair from a 32-byte `seed`. */
  ed25519KeyPairFromSeed(seed: Uint8Array): SodiumKeyPair;

  /** Detached Ed25519 signature (64 bytes) over `message` using a 64-byte secret key. */
  signDetached(message: Uint8Array, ed25519SecretKey: Uint8Array): Uint8Array;

  /** Verify a detached Ed25519 `signature` over `message` under a 32-byte public key. */
  verifyDetached(message: Uint8Array, signature: Uint8Array, ed25519PublicKey: Uint8Array): boolean;

  // --- X25519 (key agreement / sealed box) ----------------------------------

  /** Deterministically derive an X25519 keypair from a 32-byte `seed`. */
  x25519KeyPairFromSeed(seed: Uint8Array): SodiumKeyPair;

  /**
   * Anonymously seal `message` to an X25519 `recipientPublicKey` (`crypto_box_seal`).
   * Output is `SEAL_OVERHEAD_BYTES` (48) longer than the message.
   */
  sealTo(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;

  /** Open a sealed box addressed to the recipient owning `publicKey`/`secretKey`. */
  sealOpen(sealed: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;

  // --- XChaCha20-Poly1305 AEAD ----------------------------------------------

  /**
   * AEAD-encrypt `message` under a 32-byte `key` and 24-byte `nonce`. Returns the
   * combined ciphertext with the 16-byte Poly1305 tag appended.
   */
  aeadEncrypt(message: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array;

  /**
   * AEAD-decrypt a combined `ciphertextWithTag` under `key`/`nonce`. Throws
   * {@link CryptoError} if the tag does not verify.
   */
  aeadDecrypt(ciphertextWithTag: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array;

  // --- Random ----------------------------------------------------------------

  /** `n` cryptographically secure random bytes (content keys, nonces). */
  randomBytes(n: number): Uint8Array;
}

type Sodium = typeof _sodiumTypes;

/**
 * Load libsodium's WASM module. Must be awaited once before {@link libsodiumCrypto};
 * everything downstream is synchronous, which is why the async edge is here and
 * nowhere else.
 */
export async function initSodium(): Promise<SodiumCrypto> {
  await _sodium.ready;
  return libsodiumCrypto(_sodium);
}

/** Wrap an already-initialised libsodium module as a {@link SodiumCrypto}. */
export function libsodiumCrypto(sodium: Sodium): SodiumCrypto {
  const wrap = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw new CryptoError(`${what} failed`, { cause: e });
    }
  };

  return {
    ed25519KeyPairFromSeed(seed) {
      requireLength('ed25519 seed', seed, ED25519_SEED_BYTES);
      const kp = wrap('ed25519 key derivation', () => sodium.crypto_sign_seed_keypair(seed));
      return { publicKey: kp.publicKey, secretKey: kp.privateKey };
    },

    signDetached(message, ed25519SecretKey) {
      requireLength('ed25519 secret key', ed25519SecretKey, ED25519_SECRET_KEY_BYTES);
      return wrap('ed25519 sign', () => sodium.crypto_sign_detached(message, ed25519SecretKey));
    },

    verifyDetached(message, signature, ed25519PublicKey) {
      if (
        signature.length !== ED25519_SIGNATURE_BYTES ||
        ed25519PublicKey.length !== ED25519_PUBLIC_KEY_BYTES
      ) {
        // A wrong-sized signature or key is a failed verification, not a crash: this
        // runs on attacker-supplied bytes off the wire.
        return false;
      }
      try {
        return sodium.crypto_sign_verify_detached(signature, message, ed25519PublicKey);
      } catch {
        return false;
      }
    },

    x25519KeyPairFromSeed(seed) {
      requireLength('x25519 seed', seed, X25519_SEED_BYTES);
      const kp = wrap('x25519 key derivation', () => sodium.crypto_box_seed_keypair(seed));
      return { publicKey: kp.publicKey, secretKey: kp.privateKey };
    },

    sealTo(message, recipientPublicKey) {
      requireLength('x25519 public key', recipientPublicKey, X25519_PUBLIC_KEY_BYTES);
      return wrap('sealed box seal', () => sodium.crypto_box_seal(message, recipientPublicKey));
    },

    sealOpen(sealed, publicKey, secretKey) {
      requireLength('x25519 public key', publicKey, X25519_PUBLIC_KEY_BYTES);
      requireLength('x25519 secret key', secretKey, X25519_SECRET_KEY_BYTES);
      return wrap('sealed box open', () =>
        sodium.crypto_box_seal_open(sealed, publicKey, secretKey),
      );
    },

    aeadEncrypt(message, key, nonce) {
      requireLength('aead key', key, AEAD_KEY_BYTES);
      requireLength('aead nonce', nonce, AEAD_NONCE_BYTES);
      return wrap('aead encrypt', () =>
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, null, null, nonce, key),
      );
    },

    aeadDecrypt(ciphertextWithTag, key, nonce) {
      requireLength('aead key', key, AEAD_KEY_BYTES);
      requireLength('aead nonce', nonce, AEAD_NONCE_BYTES);
      return wrap('aead decrypt', () =>
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          ciphertextWithTag,
          null,
          nonce,
          key,
        ),
      );
    },

    randomBytes(n) {
      return sodium.randombytes_buf(n);
    },
  };
}

function requireLength(what: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new CryptoError(`${what} must be ${expected} bytes, was ${value.length}`);
  }
}
