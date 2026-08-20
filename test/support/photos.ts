import { createCipheriv, randomBytes } from 'node:crypto';
import { imageBlobAddress } from '../../src/images/imageBlob.js';
import type { BlobPointer } from '../../src/sync/blobPointer.js';

/**
 * The **writing** half of the image-blob format, which `src/` deliberately does not
 * have: this peer has no camera, so a packer there would be a second implementation of
 * a shared format with no caller.
 *
 * Tests still need one — a decrypt with nothing to decrypt proves nothing — so it lives
 * here, written from the layout in `ImageCipher.kt` rather than from
 * `src/images/imageCipher.ts`. That independence is the point: if the reader's idea of
 * the header drifts, this packer does not drift with it, and
 * `test/imageCipher.test.ts` pins both against blobs a real JVM produced.
 */

/** `TIC1`, the header the app writes. */
const MAGIC = Uint8Array.from([0x54, 0x49, 0x43, 0x31]);

/** A photo packed for upload: the bytes to PUT, their address, and the key. */
export interface PackedPhoto {
  readonly pointer: BlobPointer;
  readonly bytes: Uint8Array;
}

/** A 1×1 PNG — small, and a real image, so a media-type sniff has something to find. */
export const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** Encrypt `plain` under a fresh 256-bit key, exactly as `ImageBlobCrypto.pack` does. */
export function packPhoto(plain: Uint8Array = TINY_PNG): PackedPhoto {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const bytes = new Uint8Array(
    Buffer.concat([
      MAGIC,
      Uint8Array.of(iv.length),
      iv,
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  );
  return {
    pointer: { hash: imageBlobAddress(bytes), key: key.toString('base64') },
    bytes,
  };
}
