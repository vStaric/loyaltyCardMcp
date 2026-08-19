import { CONNECTION_KIND_PERSON, type ConnectInvite } from './connectInvite.js';

/**
 * The **share code** — a {@link ConnectInvite} written as hyphen-grouped uppercase
 * blocks (`4F9K-2C7X-…`), for "have them scan this, or send the code". Port of
 * `sync/sharing/ShareCode.kt`.
 *
 * The QR carries the full `loyaltycard://share` link; this is the same invite in a
 * form a person can read aloud, paste into a chat, or type in when a camera is not an
 * option. Both paths land on the identical confirm screen, and both carry the
 * identical trust anchor — that is the whole point of the encoding being lossless:
 *
 *   payload = version byte ‖ 16 raw uuid bytes ‖ 32-byte SHA-256 key fingerprint
 *
 * The fingerprint is **not truncated**. It is the TOFU pin that stops a malicious
 * server swapping the origin's key, so shortening it to make a prettier code would
 * trade real security for cosmetics. The code is therefore long (20 blocks); it is
 * meant to be copied and sent, and the QR remains the fast path.
 *
 * This is the pairing route PRD-agent-connection §7.2 prefers for an agent. The short
 * server-issued code works too, but its fingerprint arrives from the server in the same
 * breath as the uuid it is checked against, so it is a self-consistency test rather
 * than a pin. Both ends here are the user's own, so there is no reason to take the
 * weaker path.
 *
 * The display name travels in the link only. A code is keys-and-uuid, so a pasted code
 * says "this account" until the fetched roster row names them. Names are cosmetic; the
 * fingerprint is what is verified. The agent claim travels in the link only for the
 * same reason, and loses nothing by it: the claim never decided anything, and widening
 * the payload to carry a self-declared label would mean a version bump on a code
 * people have already saved, bought with nothing.
 *
 * ## Alphabet
 * Crockford base32: digits plus consonant-heavy letters, with `I`/`L` → `1`, `O` → `0`
 * on input, so a code read over the phone survives the usual confusions. Codes are
 * emitted uppercase and parsed case-insensitively.
 */

/** Crockford base32 — no `I`, `L`, `O` or `U`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters per hyphen-separated block, matching the spec's `4F9K-2C7X`. */
export const SHARE_CODE_BLOCK = 4;

/** Payload version, so a future layout can be told apart from this one. */
const VERSION = 1;

const UUID_BYTES = 16;
const FINGERPRINT_BYTES = 32;
const PAYLOAD_BYTES = 1 + UUID_BYTES + FINGERPRINT_BYTES;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render `invite` as a grouped share code, or `null` when it cannot be encoded — a
 * non-UUID account id, or a fingerprint that is not the expected 32-byte SHA-256
 * digest. Returning null rather than a best-effort code keeps a malformed invite from
 * producing a code that silently fails to connect.
 */
export function encodeShareCode(invite: ConnectInvite): string | null {
  const uuidBytes = uuidToBytes(invite.uuid);
  if (!uuidBytes) return null;
  const fingerprint = decodeBase64Url(invite.encKeyFingerprint);
  if (!fingerprint || fingerprint.length !== FINGERPRINT_BYTES) return null;

  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload[0] = VERSION;
  payload.set(uuidBytes, 1);
  payload.set(fingerprint, 1 + UUID_BYTES);
  return groupShareCode(base32Encode(payload));
}

/**
 * Parse a share code back into its invite, or `null` if `code` is not one. Tolerant of
 * the ways a code arrives after a round trip through a human: lower case, missing or
 * extra hyphens, spaces, and `I`/`L`/`O` typed for `1`/`1`/`0`.
 */
export function decodeShareCode(code: string): ConnectInvite | null {
  const payload = base32Decode(normalise(code));
  if (!payload || payload.length !== PAYLOAD_BYTES) return null;
  if (payload[0] !== VERSION) return null;
  return {
    uuid: bytesToUuid(payload.subarray(1, 1 + UUID_BYTES)),
    encKeyFingerprint: Buffer.from(payload.subarray(1 + UUID_BYTES)).toString('base64url'),
    displayName: null,
    kind: CONNECTION_KIND_PERSON,
  };
}

/** Insert the display hyphens every {@link SHARE_CODE_BLOCK} characters. */
export function groupShareCode(raw: string): string {
  return (raw.match(new RegExp(`.{1,${SHARE_CODE_BLOCK}}`, 'g')) ?? []).join('-');
}

/**
 * Strip formatting and fold the ambiguous letters onto their digits. Anything that is
 * not an alphabet character after folding is dropped, so a code pasted with surrounding
 * quotes or a trailing period still parses.
 */
function normalise(code: string): string {
  let out = '';
  for (const raw of code.toUpperCase()) {
    if (raw === 'I' || raw === 'L') out += '1';
    else if (raw === 'O') out += '0';
    else if (ALPHABET.includes(raw)) out += raw;
  }
  return out;
}

// --- base32 (big-endian bit packing) ---------------------------------------------

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  // Pad the tail with zero bits so the last partial group still round-trips.
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(text: string): Uint8Array | null {
  if (text.length === 0) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of text) {
    const value = ALPHABET.indexOf(c);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

// --- uuid <-> 16 bytes -------------------------------------------------------------

function uuidToBytes(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (!UUID_PATTERN.test(trimmed)) return null;
  return Uint8Array.from(Buffer.from(trimmed.replace(/-/g, ''), 'hex'));
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Decode a padding-free base64url string, or `null` if it is not one. Node's decoder
 * skips characters it does not recognise rather than throwing, so the re-encode check
 * stands in for the JVM decoder's exception.
 */
function decodeBase64Url(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? Uint8Array.from(bytes) : null;
}
