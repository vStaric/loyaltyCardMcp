import { createDecipheriv, type CipherGCMTypes } from 'node:crypto';

/**
 * The on-disk / on-the-wire format for encrypted card photos — the **open** half of
 * the app's `data/image/ImageCipher.kt`.
 *
 * ## Layout
 * ```
 * [4-byte magic "TIC1"][1-byte ivLen][iv][ciphertext + 16-byte GCM tag]
 * ```
 * AES/GCM, so the tag authenticates the bytes as well as hiding them: a blob that has
 * been cut short or flipped fails to decrypt rather than decoding to a mangled bitmap.
 *
 * ## Why only the open half
 * This peer has no camera and writes no photos. Porting `encrypt` would add a second
 * writer of a format two implementations already have to agree on, for a call site
 * that does not exist. A card this agent re-publishes carries its author's pointers
 * forward verbatim (see `CardService.update`); it never mints a blob of its own.
 *
 * ## Key
 * Like the app's, this module never *holds* a key — callers pass one in. On the device
 * the at-rest key is a non-exportable Keystore key; the key that opens a *blob* is the
 * random per-photo one carried in the card snapshot. Same format, different key, which
 * is exactly the reuse `sync/blob/ImageBlobs.kt` was built on.
 */

/** `TIC1` — Tolar Image Cipher, format version 1. */
export const IMAGE_BLOB_MAGIC = Uint8Array.from([0x54, 0x49, 0x43, 0x31]);

/** Bytes before the `ivLen` byte. */
const MAGIC_SIZE = 4;

/** GCM tag length, in bytes — the app's `GCM_TAG_BITS = 128`. */
const TAG_BYTES = 16;

/**
 * The cipher each AES key size names — the three the JVM's `AES/GCM/NoPadding` accepts.
 *
 * A table rather than a computed `aes-${bits}-gcm`, because the key length arrives from
 * a card snapshot written elsewhere: this way a key of any other length has no entry
 * and is refused, instead of naming a cipher that does not exist.
 */
const CIPHERS: Readonly<Record<number, CipherGCMTypes>> = {
  16: 'aes-128-gcm',
  24: 'aes-192-gcm',
  32: 'aes-256-gcm',
};

/** True if `blob` carries this format's header. */
export function isEncryptedImage(blob: Uint8Array): boolean {
  return blob.length >= MAGIC_SIZE && IMAGE_BLOB_MAGIC.every((byte, i) => blob[i] === byte);
}

/**
 * Decrypt a whole blob produced by the app's `ImageCipher.encrypt`.
 *
 * Buffered rather than streamed, for the same reason the app buffers: a card photo is
 * a single image its reader needs whole, and finishing the cipher over the complete
 * ciphertext is what turns a failed tag into a thrown error instead of a short read.
 *
 * @throws {ImageBlobFormatError} if `blob` is not in this format, or `key` is not an
 *   AES key size
 * @throws {ImageBlobAuthError} if the bytes fail authentication — a wrong key, or bytes
 *   that were altered after they were sealed
 */
export function decryptImageBlob(blob: Uint8Array, key: Uint8Array): Uint8Array {
  if (!isEncryptedImage(blob)) {
    throw new ImageBlobFormatError('not an encrypted image blob: no TIC1 header');
  }
  const cipher = CIPHERS[key.length];
  if (!cipher) {
    throw new ImageBlobFormatError(`an AES key is 16, 24 or 32 bytes; this one is ${key.length}`);
  }
  const ivLen = blob[MAGIC_SIZE]!;
  const start = MAGIC_SIZE + 1 + ivLen;
  // The tag is the last 16 bytes, so a blob with nothing between the IV and the tag is
  // still well-formed (an empty photo); one too short to hold the tag is not.
  if (ivLen === 0 || blob.length < start + TAG_BYTES) {
    throw new ImageBlobFormatError('the encrypted image is incomplete');
  }
  const iv = blob.subarray(MAGIC_SIZE + 1, start);
  const body = blob.subarray(start, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  // Node wants the tag separately; the JVM's `doFinal` takes it concatenated to the
  // ciphertext. Same bytes in the same order — only the API differs.
  const decipher = createDecipheriv(cipher, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch (e) {
    throw new ImageBlobAuthError(
      `the image did not authenticate under this key: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

/** The bytes are not an image blob this version can read at all. */
export class ImageBlobFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageBlobFormatError';
  }
}

/**
 * The bytes are an image blob and the tag did not check out.
 *
 * Distinct from {@link ImageBlobFormatError} because the two say different things
 * about who is at fault: a bad header is a blob that is not a photo, a bad tag is a
 * photo that is not the one this key opens — a wrong key, or altered bytes.
 */
export class ImageBlobAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageBlobAuthError';
  }
}
