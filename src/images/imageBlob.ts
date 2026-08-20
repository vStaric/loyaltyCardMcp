import { createHash } from 'node:crypto';
import { decryptImageBlob, ImageBlobFormatError } from './imageCipher.js';

/**
 * The blob wire format: {@link decryptImageBlob}'s format under the per-photo key a
 * card snapshot carries — the read half of `sync/blob/ImageBlobs.kt`.
 *
 * There is deliberately no second crypto path. The app built its `ImageCipher`
 * key-agnostic precisely so the same AES/GCM format could be reused with a shared key
 * instead of the device's Keystore key, and this port keeps that: what travels from
 * the server is byte-identical in shape to what sits on an owner's disk.
 *
 * ## The key is not a second sharing mechanism
 * A blob key rides *inside* the card snapshot, which is sealed into an envelope whose
 * content key is wrapped per recipient. So a photo is readable exactly when the card
 * naming it is: nothing here grants access the cards resource did not already grant.
 */

/**
 * The address of `bytes` in the content-addressed store: lowercase-hex SHA-256 of the
 * **ciphertext**, which is what the server recomputes and enforces on upload.
 *
 * Hashing the plaintext instead would let the server tell that two accounts hold the
 * same photo, which is the correlation the whole blob design exists to deny it.
 */
export function imageBlobAddress(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decrypt a downloaded blob with the base64 `key` from a card snapshot.
 *
 * @throws {ImageBlobFormatError} if `key` is not base64 of an AES key, or `bytes` are
 *   not an image blob
 * @throws {import('./imageCipher.js').ImageBlobAuthError} if the key does not open them
 */
export function openImageBlob(bytes: Uint8Array, key: string): Uint8Array {
  return decryptImageBlob(bytes, decodeKey(key));
}

/**
 * A base64 AES key as bytes.
 *
 * The alphabet is checked first because Node's decoder is lenient — it drops what it
 * cannot read rather than complaining — so a mistyped key would arrive downstream as a
 * short buffer and be reported as a failed tag, blaming the blob for a fault in the
 * pointer. Padding is optional here even though the app always writes it: a key that
 * decodes to the right bytes is a working key, and rejecting one over its `=` would be
 * this port inventing a rule the format does not have.
 */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeKey(key: string): Uint8Array {
  const trimmed = key.trim();
  if (!BASE64.test(trimmed)) {
    throw new ImageBlobFormatError(`the photo's key is not base64: ${key}`);
  }
  return new Uint8Array(Buffer.from(trimmed, 'base64'));
}
