import { asObject, str } from './json.js';

/**
 * Where a card photo lives in the content-addressed blob store, and the key that
 * opens it — port of `sync/blob/BlobPointer.kt`.
 *
 * The key rides *inside* the card snapshot, which is itself sealed into an envelope
 * whose CEK is wrapped per recipient, so a blob key inherits exactly the sharing the
 * card has: no second key-distribution mechanism to keep in step with the first.
 *
 * `hash` is the SHA-256 of the **ciphertext** as uploaded — what the server recomputes
 * and enforces. Hashing the plaintext would tell the server that two accounts hold the
 * same photo.
 *
 * This peer neither packs nor opens blobs (that needs the app's `ImageCipher` format,
 * filed separately): it carries pointers through a re-publish unchanged, so a card it
 * edits keeps the photos its author attached.
 */
export interface BlobPointer {
  /** Lowercase-hex SHA-256 of the uploaded ciphertext — the blob's address. */
  readonly hash: string;
  /** Base64 of the raw AES key the blob is encrypted under. */
  readonly key: string;
}

/** Read a pointer out of snapshot JSON, or `null` when the writer named none. */
export function blobPointerFromJson(raw: unknown, what: string): BlobPointer | null {
  if (raw === undefined || raw === null) return null;
  const o = asObject(raw, what);
  return { hash: str(o, 'hash', what), key: str(o, 'key', what) };
}

/** Project a pointer back onto its snapshot JSON, verbatim. */
export function blobPointerToJson(pointer: BlobPointer): Record<string, unknown> {
  return { hash: pointer.hash, key: pointer.key };
}
