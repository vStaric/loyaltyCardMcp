import { describe, expect, it } from 'vitest';
import { imageBlobAddress, openImageBlob } from '../src/images/imageBlob.js';
import {
  ImageBlobAuthError,
  ImageBlobFormatError,
  decryptImageBlob,
  isEncryptedImage,
} from '../src/images/imageCipher.js';
import { sniffImageMediaType } from '../src/images/mediaType.js';
import { TINY_PNG, packPhoto } from './support/photos.js';

/**
 * The image-blob format, pinned against blobs a **JVM** produced.
 *
 * This is a port of `data/image/ImageCipher.kt` under the per-photo key of
 * `sync/blob/ImageBlobs.kt`, and a port of a format has exactly one interesting failure
 * mode: agreeing with itself and with nothing else. So the vectors below were not
 * written by hand and not produced by this code. They came out of a Java program that
 * calls `Cipher.getInstance("AES/GCM/NoPadding")` and writes the header the same way
 * `ImageCipher.encrypt` does — the app's own crypto provider, one layer removed.
 *
 * If this file goes red, the reader has drifted from the writer on the other side of
 * the wire, and the symptom in the field would be a card photo that will not open.
 */

/** A 1×1 PNG sealed under a 256-bit key by the JVM. */
const PNG_VECTOR = {
  key: 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=',
  blob:
    'VElDMQypKldNq4Ppk+dSkJ4oE3i9HAwfHJv34GUMisJvyUzyI69dufdmQQDui186KgZc5qlB13P3y5tS' +
    'hGYVLnmHgyLVnCE2QlD1FqvpiwwWVgWGVk23G/Z9unufTxrknERE7+XC/A==',
  address: '86c8f2ddd6a098ab633ac4f21dc5a976a0ff4d6b74aa86a2288cb9459486d4ee',
};

/**
 * The smallest legal JPEG, sealed under a **128-bit** key by the same program.
 *
 * The app generates 256-bit keys, so this vector is not a case that arises today. It is
 * here because the key length is read off the key rather than assumed, and the cheapest
 * way for that to rot is for nothing to exercise it.
 */
const JPEG_VECTOR = {
  key: 'yMXCv7y5trOwraqnpKGemw==',
  blob: 'VElDMQx7MJnqKbGcLxNuajDJqFgfVg6atGPrKQ42w8FWpp3Ayuf7kIlh5SZyQPowDskHbr7vKw==',
  address: '7377edfa7270a771d15855332066e108862fb3e1ceaf9ef0ffc2e1df613d2e83',
  plain: '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==',
};

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

describe('the app-written vectors', () => {
  it('opens a photo the JVM sealed, byte for byte', () => {
    const plain = openImageBlob(bytes(PNG_VECTOR.blob), PNG_VECTOR.key);
    expect(Buffer.from(plain)).toEqual(Buffer.from(TINY_PNG));
  });

  it('reads the key size off the key rather than assuming 256 bits', () => {
    const plain = openImageBlob(bytes(JPEG_VECTOR.blob), JPEG_VECTOR.key);
    expect(Buffer.from(plain).toString('base64')).toBe(JPEG_VECTOR.plain);
  });

  it('addresses a blob the way the server does — SHA-256 of the ciphertext', () => {
    expect(imageBlobAddress(bytes(PNG_VECTOR.blob))).toBe(PNG_VECTOR.address);
    expect(imageBlobAddress(bytes(JPEG_VECTOR.blob))).toBe(JPEG_VECTOR.address);
  });

  it('carries the header the app documents: TIC1, then the IV length', () => {
    const blob = bytes(PNG_VECTOR.blob);
    expect(Buffer.from(blob.subarray(0, 4)).toString('ascii')).toBe('TIC1');
    expect(blob[4]).toBe(12);
    expect(isEncryptedImage(blob)).toBe(true);
  });
});

describe('bytes that are not a photo this key opens', () => {
  it('rejects anything without the magic — including the plaintext image itself', () => {
    expect(isEncryptedImage(TINY_PNG)).toBe(false);
    expect(() => decryptImageBlob(TINY_PNG, bytes(PNG_VECTOR.key))).toThrow(ImageBlobFormatError);
  });

  it('rejects a blob too short to hold its own tag', () => {
    const cut = bytes(PNG_VECTOR.blob).subarray(0, 20);
    expect(() => decryptImageBlob(cut, bytes(PNG_VECTOR.key))).toThrow(/incomplete/);
  });

  it('rejects a key that is not an AES key size, rather than naming a cipher', () => {
    expect(() => decryptImageBlob(bytes(PNG_VECTOR.blob), new Uint8Array(20))).toThrow(
      /16, 24 or 32 bytes/,
    );
  });

  it('names a mistyped key as a bad key, not as a bad photo', () => {
    // Node's base64 decoder drops what it cannot read, so without the alphabet check
    // this arrives as a short key and is blamed on the blob.
    expect(() => openImageBlob(bytes(PNG_VECTOR.blob), 'not a key!!')).toThrow(/not base64/);
  });

  it('accepts a key whose padding was stripped, because it still opens the photo', () => {
    const unpadded = JPEG_VECTOR.key.replace(/=+$/, '');
    expect(Buffer.from(openImageBlob(bytes(JPEG_VECTOR.blob), unpadded)).toString('base64')).toBe(
      JPEG_VECTOR.plain,
    );
  });

  it('fails a flipped byte on the tag, not on the decode', () => {
    // The whole reason the app buffers instead of streaming: a tampered photo must
    // throw, never decode to a mangled bitmap.
    const tampered = bytes(PNG_VECTOR.blob);
    tampered[30] = tampered[30]! ^ 0x01;
    expect(() => decryptImageBlob(tampered, bytes(PNG_VECTOR.key))).toThrow(ImageBlobAuthError);
  });

  it("fails a photo opened with somebody else's key", () => {
    expect(() => openImageBlob(bytes(PNG_VECTOR.blob), JPEG_VECTOR.key)).toThrow(
      ImageBlobAuthError,
    );
  });
});

describe('what kind of image came out', () => {
  it('names the formats a phone camera or picker produces', () => {
    expect(sniffImageMediaType(TINY_PNG)).toBe('image/png');
    expect(sniffImageMediaType(bytes(JPEG_VECTOR.plain))).toBe('image/jpeg');
    expect(
      sniffImageMediaType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp');
    expect(
      sniffImageMediaType(
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      ),
    ).toBe('image/heic');
  });

  it('answers null rather than guessing at bytes it does not know', () => {
    // Nothing on the wire declares a media type, so the alternative to null is a label
    // the host cannot draw. `null` is what makes the tool say so instead.
    expect(sniffImageMediaType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(sniffImageMediaType(new Uint8Array())).toBeNull();
  });
});

describe('the packer the tests use', () => {
  it('produces blobs this reader opens, at the address it claims', () => {
    const packed = packPhoto();
    expect(imageBlobAddress(packed.bytes)).toBe(packed.pointer.hash);
    expect(Buffer.from(openImageBlob(packed.bytes, packed.pointer.key))).toEqual(
      Buffer.from(TINY_PNG),
    );
  });
});
