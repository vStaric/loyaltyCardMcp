/**
 * What kind of image a decrypted photo is, read from its own first bytes.
 *
 * Nothing on the wire says. A card snapshot carries a pointer and a key, never a
 * media type, and the app does not need one — it hands the bytes to a decoder that
 * sniffs them anyway. An MCP image block does need one, so this is where the answer
 * comes from: the file's magic, the same evidence `ImageCipher`'s header comment
 * leans on when it argues that no image can begin with `TIC1`.
 *
 * Guessing from the stored file name would be worse than useless: `ImageStore` names
 * every photo `<uuid>.jpg` regardless of what the camera or picker actually produced.
 */

/** The media type `bytes` announce, or `null` for a payload this does not recognise. */
export function sniffImageMediaType(bytes: Uint8Array): string | null {
  for (const format of FORMATS) {
    if (format.matches(bytes)) return format.mediaType;
  }
  return null;
}

/** True when `bytes` start with `magic`. */
function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);
}

/** True when `text` sits at `offset` as ASCII. */
function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The formats an Android camera or photo picker can hand the app, most likely first.
 *
 * HEIF and its AVIF sibling are one entry: both are ISO-BMFF, both put `ftyp` at
 * offset 4, and the brand that follows is what separates them.
 */
const FORMATS: readonly {
  readonly mediaType: string;
  readonly matches: (b: Uint8Array) => boolean;
}[] = [
  { mediaType: 'image/jpeg', matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    mediaType: 'image/png',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mediaType: 'image/webp', matches: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  { mediaType: 'image/gif', matches: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  { mediaType: 'image/bmp', matches: (b) => ascii(b, 0, 'BM') },
  {
    mediaType: 'image/heic',
    matches: (b) =>
      ascii(b, 4, 'ftyp') &&
      ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].some((brand) => ascii(b, 8, brand)),
  },
  {
    mediaType: 'image/avif',
    matches: (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')),
  },
];
