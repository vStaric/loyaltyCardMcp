import { envelopeSignedBytes, type Envelope, type EnvelopeData } from './envelope.js';
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  CryptoError,
  type SodiumCrypto,
  type SodiumKeyPair,
} from './sodium.js';

/** A recipient the content key is wrapped for: their account UUID + X25519 public key. */
export interface Recipient {
  readonly uuid: string;
  readonly x25519PublicKey: Uint8Array;
}

/**
 * The content-encryption facade for sync: turns plaintext resource bytes into a
 * signed, multi-recipient {@link Envelope} and back. Port of `crypto/EnvelopeCrypto.kt`.
 *
 * ## Scheme (PRD-sync-sharing §5)
 * 1. A fresh random **content key** (CEK, 256-bit) and 192-bit nonce encrypt the
 *    payload with XChaCha20-Poly1305 → `data`.
 * 2. The CEK is wrapped once per recipient with an X25519 **sealed box** to that
 *    recipient's encryption public key → `keys`. Sealed boxes are anonymous, so the
 *    wrapping leaks nothing about the author.
 * 3. The author Ed25519-signs the {@link envelopeSignedBytes} layout → `signature`,
 *    binding `resourceType`, `resourceId` and `ver` so an envelope cannot be replayed
 *    onto another resource or version.
 *
 * Sign-then-publish: the signature covers the already-encrypted body, so the server
 * (which only ever verifies) authenticates content without seeing plaintext.
 *
 * All base64 is standard padded, matching the server's `java.util.Base64`.
 *
 * The server never decrypts, so no amount of server-side checking can catch this class
 * drifting from the app's `EnvelopeCrypto.kt` — a break surfaces as a user unable to
 * open a list the other client sealed. Both directions are therefore pinned against
 * fixed vectors that neither implementation owns (`test-vectors/envelope-crypto.json`):
 * envelopes that must open to known plaintext, and bodies that must sign to known
 * signatures.
 */
export class EnvelopeCrypto {
  constructor(private readonly sodium: SodiumCrypto) {}

  /**
   * Encrypt `plaintext` under a fresh content key wrapped for each of `recipients`.
   * Returns an unsigned envelope (no `signature`); call {@link sign} — or use
   * {@link seal} to do both — before publishing.
   *
   * A recipient list that omits the author means the author cannot later decrypt
   * their own resource; callers include themselves as a recipient.
   */
  encrypt(plaintext: Uint8Array, recipients: readonly Recipient[]): Envelope {
    const cek = this.sodium.randomBytes(AEAD_KEY_BYTES);
    const nonce = this.sodium.randomBytes(AEAD_NONCE_BYTES);
    const combined = this.sodium.aeadEncrypt(plaintext, cek, nonce);

    // Split libsodium's combined output into the wire's ciphertext + tag halves.
    const tagStart = combined.length - AEAD_TAG_BYTES;
    const ciphertext = combined.subarray(0, tagStart);
    const tag = combined.subarray(tagStart);

    const keys: Record<string, string> = {};
    for (const r of recipients) {
      keys[r.uuid] = b64(this.sodium.sealTo(cek, r.x25519PublicKey));
    }

    return {
      data: { iv: b64(nonce), ciphertext: b64(ciphertext), tag: b64(tag) },
      keys,
    };
  }

  /**
   * Attach an author signature to `envelope` for the resource it targets, returning a
   * fully-formed, publishable envelope. `signerUuid` is the author's account UUID and
   * `signerEd25519SecretKey` their 64-byte signing key.
   */
  sign(
    resourceType: string,
    resourceId: string,
    ver: number,
    envelope: Envelope,
    signerUuid: string,
    signerEd25519SecretKey: Uint8Array,
  ): Envelope {
    const bytes = envelopeSignedBytes(resourceType, resourceId, ver, envelope.data, envelope.keys);
    const sig = this.sodium.signDetached(bytes, signerEd25519SecretKey);
    return {
      ...envelope,
      signature: { by: signerUuid, ver, sig: b64(sig) },
    };
  }

  /** Encrypt then sign in one step — the common publish path. */
  seal(
    resourceType: string,
    resourceId: string,
    ver: number,
    plaintext: Uint8Array,
    recipients: readonly Recipient[],
    signerUuid: string,
    signerEd25519SecretKey: Uint8Array,
  ): Envelope {
    return this.sign(
      resourceType,
      resourceId,
      ver,
      this.encrypt(plaintext, recipients),
      signerUuid,
      signerEd25519SecretKey,
    );
  }

  /**
   * Verify `envelope`'s embedded signature against an author public key, exactly as
   * the server does: recompute the signed bytes from the envelope's own fields plus
   * `resourceType`/`resourceId` and the signed `ver`, then Ed25519-verify. Returns
   * false for an unsigned envelope or any verification failure.
   */
  verify(
    resourceType: string,
    resourceId: string,
    envelope: Envelope,
    authorEd25519PublicKey: Uint8Array,
  ): boolean {
    const signature = envelope.signature;
    if (!signature) return false;
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = envelopeSignedBytes(
        resourceType,
        resourceId,
        signature.ver,
        envelope.data,
        envelope.keys,
      );
      sig = decodeB64Strict(signature.sig);
    } catch {
      return false;
    }
    return this.sodium.verifyDetached(bytes, sig, authorEd25519PublicKey);
  }

  /**
   * Decrypt `envelope` for the recipient owning `recipientUuid` and the X25519
   * `recipientKeyPair`. Unwraps this recipient's CEK from `keys`, then AEAD-opens the
   * body.
   *
   * @throws {CryptoError} if there is no wrapped key for `recipientUuid`, the sealed
   *   box does not open under this keypair, or the AEAD tag fails.
   */
  decrypt(envelope: Envelope, recipientUuid: string, recipientKeyPair: SodiumKeyPair): Uint8Array {
    const wrappedB64 = envelope.keys[recipientUuid];
    if (wrappedB64 === undefined) {
      throw new CryptoError(`no wrapped key for recipient ${recipientUuid}`);
    }
    const cek = this.sodium.sealOpen(
      decodeEnvelopeB64(wrappedB64, 'wrapped key'),
      recipientKeyPair.publicKey,
      recipientKeyPair.secretKey,
    );
    const nonce = decodeEnvelopeB64(envelope.data.iv, 'iv');
    const ciphertext = decodeEnvelopeB64(envelope.data.ciphertext, 'ciphertext');
    const tag = decodeEnvelopeB64(envelope.data.tag, 'tag');
    return this.sodium.aeadDecrypt(concat(ciphertext, tag), cek, nonce);
  }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Node's base64 decoder is famously permissive — it skips characters it does not
 * recognise instead of failing — so a strict re-encode check stands in for the JVM's
 * `IllegalArgumentException`. Without it, a tampered envelope field would decode to
 * *something* and fail later (or, for the signature, verify against the wrong bytes)
 * rather than being rejected as malformed here.
 */
function decodeB64Strict(s: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(s, 'base64'));
  if (b64(bytes) !== s) throw new CryptoError('malformed base64');
  return bytes;
}

function decodeEnvelopeB64(s: string, field: string): Uint8Array {
  try {
    return decodeB64Strict(s);
  } catch (e) {
    throw new CryptoError(`malformed base64 in envelope ${field}`, { cause: e });
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export type { Envelope, EnvelopeData };
