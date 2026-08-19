import { describe, expect, it } from 'vitest';
import { identityFromSeed } from '../src/crypto/identity.js';
import { initSodium } from '../src/crypto/sodium.js';
import {
  CONNECTION_KIND_AGENT,
  CONNECTION_KIND_PERSON,
  connectionKindFromWire,
  inviteToUri,
  parseInvite,
  type ConnectInvite,
} from '../src/sharing/connectInvite.js';
import { fingerprintMatches, fingerprintOf, safetyNumber } from '../src/sharing/keyFingerprint.js';
import { decodeShareCode, encodeShareCode } from '../src/sharing/shareCode.js';

/**
 * The connect-invite trio: the fingerprint that is the TOFU pin, the link that carries
 * it out-of-band, and the typeable code that carries the identical payload.
 *
 * The property that matters throughout is that a code is the **same invite** as the QR
 * link, including the full untruncated fingerprint — both feed the identical
 * verification, so a code that carried a weaker anchor would quietly downgrade the
 * pairing that PRD-agent-connection §7.2 chose *because* it is the stronger path.
 */
const UUID = '0b6b3c2a-1f4d-4e8a-9c2b-7a1f0e5d6c3b';
const FINGERPRINT_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const FINGERPRINT = Buffer.from(FINGERPRINT_BYTES).toString('base64url');

const invite: ConnectInvite = {
  uuid: UUID,
  encKeyFingerprint: FINGERPRINT,
  displayName: 'Ana',
  kind: CONNECTION_KIND_PERSON,
};

describe('key fingerprint', () => {
  it('is the unpadded base64url SHA-256 of the key', () => {
    // Known answer: SHA-256 of the empty input, the canonical vector.
    const fp = fingerprintOf(new Uint8Array(0));
    expect(fp).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    expect(fp).not.toContain('=');
    expect(Buffer.from(fp, 'base64url')).toHaveLength(32);
  });

  it('matches only the key it was taken from, and tolerates surrounding whitespace', async () => {
    const sodium = await initSodium();
    const id = identityFromSeed(
      Uint8Array.from({ length: 64 }, (_, i) => i),
      sodium,
    );
    const other = identityFromSeed(
      Uint8Array.from({ length: 64 }, (_, i) => i + 1),
      sodium,
    );
    const fp = fingerprintOf(id.encPublicKey);
    expect(fingerprintMatches(id.encPublicKey, fp)).toBe(true);
    expect(fingerprintMatches(id.encPublicKey, `  ${fp}  `)).toBe(true);
    expect(fingerprintMatches(other.encPublicKey, fp)).toBe(false);
    expect(fingerprintMatches(id.encPublicKey, 'truncated')).toBe(false);
  });

  it('renders a safety number as five-character hex blocks', () => {
    const sn = safetyNumber(new Uint8Array(0));
    expect(sn.startsWith('e3b0c 44298 fc1c1')).toBe(true);
    expect(sn.replace(/ /g, '')).toHaveLength(64);
    expect(sn.split(' ').every((block) => block.length <= 5)).toBe(true);
  });
});

describe('connect invite link', () => {
  it('round-trips through the canonical uri', () => {
    const uri = inviteToUri(invite);
    expect(uri.startsWith('loyaltycard://share?u=')).toBe(true);
    expect(parseInvite(uri)).toEqual(invite);
  });

  it('keeps a person link byte-identical to what the app has always emitted', () => {
    // No `t=` for a person: the absence already means person, and adding it would
    // change the shape of every ordinary invite for nothing.
    expect(inviteToUri(invite)).not.toContain('t=');
    expect(inviteToUri({ ...invite, kind: CONNECTION_KIND_AGENT })).toContain('&t=agent');
  });

  it('carries a name with spaces and non-ASCII through base64url', () => {
    const named = { ...invite, displayName: 'Ana & Bo — ürlaub' };
    expect(parseInvite(inviteToUri(named))?.displayName).toBe('Ana & Bo — ürlaub');
  });

  it('omits a blank name rather than emitting an empty parameter', () => {
    expect(inviteToUri({ ...invite, displayName: '   ' })).not.toContain('n=');
    expect(parseInvite(inviteToUri({ ...invite, displayName: null }))?.displayName).toBeNull();
  });

  it('rejects a link missing the uuid or the fingerprint', () => {
    expect(parseInvite(`loyaltycard://share?u=${UUID}`)).toBeNull();
    expect(parseInvite(`loyaltycard://share?k=${FINGERPRINT}`)).toBeNull();
    expect(parseInvite('https://example.com/share?u=x&k=y')).toBeNull();
    expect(parseInvite('not a uri')).toBeNull();
  });

  it('degrades an unreadable name or kind instead of rejecting the invite', () => {
    // A bad name is cosmetic and a bad kind is a claim; neither is a reason to refuse a
    // link whose uuid and fingerprint — the parts that are verified — are intact.
    const parsed = parseInvite(
      `loyaltycard://share?u=${UUID}&k=${FINGERPRINT}&n=!!not-base64!!&t=robot`,
    );
    expect(parsed?.uuid).toBe(UUID);
    expect(parsed?.displayName).toBeNull();
    expect(parsed?.kind).toBe(CONNECTION_KIND_PERSON);
  });

  it('reads the kind claim as person for anything it does not recognise', () => {
    expect(connectionKindFromWire('agent')).toBe(CONNECTION_KIND_AGENT);
    expect(connectionKindFromWire('AGENT')).toBe(CONNECTION_KIND_AGENT);
    expect(connectionKindFromWire('person')).toBe(CONNECTION_KIND_PERSON);
    expect(connectionKindFromWire(null)).toBe(CONNECTION_KIND_PERSON);
    expect(connectionKindFromWire(undefined)).toBe(CONNECTION_KIND_PERSON);
    expect(connectionKindFromWire('')).toBe(CONNECTION_KIND_PERSON);
    expect(connectionKindFromWire('android')).toBe(CONNECTION_KIND_PERSON);
  });
});

describe('share code', () => {
  /**
   * Known answer produced by transliterating the app's `ShareCode.encode` onto the JVM.
   * The base32 packing is a wire format between the app and this peer: if it drifts, a
   * code the user pastes into the app resolves to a different account or to nothing.
   */
  const JVM_CODE =
    '045P-PF1A-3X6M-X2MW-5DX1-Y3JX-DGXG-62GH-30FJ-CB9M-7D14-JM2Q-BSJP-RWVT-G648-Z5MX-MJNV-5EE0-RZ7D-BQ0';

  it('matches the code the app would emit for the same invite', () => {
    expect(encodeShareCode(invite)).toBe(JVM_CODE);
  });

  it('round-trips the uuid and the whole fingerprint', () => {
    const decoded = decodeShareCode(JVM_CODE);
    expect(decoded?.uuid).toBe(UUID);
    // Not a prefix, not a hash of it — the exact fingerprint the link carries, or the
    // code would verify against a weaker anchor than the QR.
    expect(decoded?.encKeyFingerprint).toBe(FINGERPRINT);
  });

  it('does not carry the name or the kind claim', () => {
    const decoded = decodeShareCode(encodeShareCode(invite)!)!;
    expect(decoded.displayName).toBeNull();
    expect(
      decodeShareCode(encodeShareCode({ ...invite, kind: CONNECTION_KIND_AGENT })!)!.kind,
    ).toBe(CONNECTION_KIND_PERSON);
  });

  it('is grouped into four-character blocks of unambiguous uppercase characters', () => {
    const code = encodeShareCode(invite)!;
    const blocks = code.split('-');
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks.slice(0, -1)) expect(block).toHaveLength(4);
    expect(blocks.at(-1)!.length).toBeGreaterThan(0);
    const raw = code.replace(/-/g, '');
    expect(raw).toBe(raw.toUpperCase());
    for (const ambiguous of ['I', 'L', 'O', 'U']) expect(raw).not.toContain(ambiguous);
  });

  it('survives a trip through a human', () => {
    const code = encodeShareCode(invite)!;
    // Lower case, hyphens stripped, spaces added, and the classic confusions: I/l typed
    // for 1, O typed for 0.
    const mangled = code.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'O');
    expect(decodeShareCode(mangled)).toEqual(decodeShareCode(code));
  });

  it('rejects things that are not codes, including a truncated one', () => {
    expect(decodeShareCode('')).toBeNull();
    expect(decodeShareCode('hello')).toBeNull();
    const code = encodeShareCode(invite)!;
    expect(decodeShareCode(code.slice(0, code.length - 8))).toBeNull();
  });

  it('refuses to encode an invite it cannot represent losslessly', () => {
    // A best-effort code here would be a code that silently fails to connect.
    expect(encodeShareCode({ ...invite, uuid: 'not-a-uuid' })).toBeNull();
    expect(
      encodeShareCode({ ...invite, encKeyFingerprint: Buffer.from('short').toString('base64url') }),
    ).toBeNull();
    expect(encodeShareCode({ ...invite, encKeyFingerprint: '!!!not base64!!!' })).toBeNull();
  });
});
