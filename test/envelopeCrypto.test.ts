import { beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto, type Recipient } from '../src/crypto/envelopeCrypto.js';
import { identityFromSeed, type Identity } from '../src/crypto/identity.js';
import { CryptoError, initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';

/**
 * Exercises the seal / open / sign / verify surface end to end.
 *
 * The layout these produce is pinned separately by `envelopeSigning.test.ts`; what
 * this file guards is the behaviour that would otherwise fail *quietly* — a recipient
 * left out of the key map still decrypting, a tampered ciphertext still verifying, a
 * signature that survives being replayed onto another resource.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let author: Identity;
let peer: Identity;
let stranger: Identity;

const seedOf = (fill: number) => Uint8Array.from({ length: 64 }, (_, i) => (i + fill) & 0xff);
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const recipientFor = (id: Identity): Recipient => ({
  uuid: id.uuid,
  x25519PublicKey: id.encPublicKey,
});

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  author = identityFromSeed(seedOf(0), sodium);
  peer = identityFromSeed(seedOf(100), sodium);
  stranger = identityFromSeed(seedOf(200), sodium);
});

describe('EnvelopeCrypto', () => {
  it('seals to several recipients and each opens it', () => {
    const plaintext = utf8('{"items":[{"name":"milk"}]}');
    const envelope = crypto.seal(
      'shoppinglist',
      `list::${author.uuid}`,
      1,
      plaintext,
      [recipientFor(author), recipientFor(peer)],
      author.uuid,
      author.signingKeyPair.secretKey,
    );

    expect(Object.keys(envelope.keys).sort()).toEqual([author.uuid, peer.uuid].sort());
    expect(text(crypto.decrypt(envelope, author.uuid, author.encryptionKeyPair))).toBe(
      text(plaintext),
    );
    expect(text(crypto.decrypt(envelope, peer.uuid, peer.encryptionKeyPair))).toBe(text(plaintext));
  });

  it('leaves a non-recipient unable to decrypt at all', () => {
    // "Granting only the shopping list means the agent cannot decrypt the cards blob at
    // all — not 'does not show it', cannot read it." (PRD-agent-connection §9.)
    const envelope = crypto.seal(
      'cards',
      author.uuid,
      1,
      utf8('secret'),
      [recipientFor(author)],
      author.uuid,
      author.signingKeyPair.secretKey,
    );
    expect(() => crypto.decrypt(envelope, stranger.uuid, stranger.encryptionKeyPair)).toThrow(
      CryptoError,
    );
    // Not even with someone else's wrapped key in hand: the sealed box is to their key.
    const forged = { ...envelope, keys: { [stranger.uuid]: envelope.keys[author.uuid]! } };
    expect(() => crypto.decrypt(forged, stranger.uuid, stranger.encryptionKeyPair)).toThrow(
      CryptoError,
    );
  });

  it('verifies its own signature and rejects a mismatched author key', () => {
    const envelope = crypto.seal(
      'cards',
      author.uuid,
      3,
      utf8('cards'),
      [recipientFor(author)],
      author.uuid,
      author.signingKeyPair.secretKey,
    );
    expect(crypto.verify('cards', author.uuid, envelope, author.signPublicKey)).toBe(true);
    expect(crypto.verify('cards', author.uuid, envelope, stranger.signPublicKey)).toBe(false);
  });

  it('binds the signature to the resource, its id and its version', () => {
    const envelope = crypto.seal(
      'cards',
      author.uuid,
      3,
      utf8('cards'),
      [recipientFor(author)],
      author.uuid,
      author.signingKeyPair.secretKey,
    );
    // The same bytes replayed onto another resource, id or version must not verify.
    expect(crypto.verify('share', author.uuid, envelope, author.signPublicKey)).toBe(false);
    expect(crypto.verify('cards', peer.uuid, envelope, author.signPublicKey)).toBe(false);
    const bumped = { ...envelope, signature: { ...envelope.signature!, ver: 4 } };
    expect(crypto.verify('cards', author.uuid, bumped, author.signPublicKey)).toBe(false);
  });

  it('rejects a tampered body or recipient map', () => {
    const envelope = crypto.seal(
      'cards',
      author.uuid,
      1,
      utf8('cards'),
      [recipientFor(author)],
      author.uuid,
      author.signingKeyPair.secretKey,
    );
    const tamperedBody = {
      ...envelope,
      data: { ...envelope.data, ciphertext: flipLastBase64Char(envelope.data.ciphertext) },
    };
    expect(crypto.verify('cards', author.uuid, tamperedBody, author.signPublicKey)).toBe(false);

    const addedRecipient = {
      ...envelope,
      keys: { ...envelope.keys, [peer.uuid]: envelope.keys[author.uuid]! },
    };
    expect(crypto.verify('cards', author.uuid, addedRecipient, author.signPublicKey)).toBe(false);
  });

  it('treats an unsigned or malformed signature as unverified rather than throwing', () => {
    const unsigned = crypto.encrypt(utf8('x'), [recipientFor(author)]);
    expect(crypto.verify('cards', author.uuid, unsigned, author.signPublicKey)).toBe(false);

    const garbled = {
      ...unsigned,
      signature: { by: author.uuid, ver: 1, sig: 'not base64 !!!' },
    };
    expect(crypto.verify('cards', author.uuid, garbled, author.signPublicKey)).toBe(false);
  });

  it('fails an AEAD tag that does not verify', () => {
    const envelope = crypto.seal(
      'cards',
      author.uuid,
      1,
      utf8('cards'),
      [recipientFor(author)],
      author.uuid,
      author.signingKeyPair.secretKey,
    );
    const tampered = {
      ...envelope,
      data: { ...envelope.data, tag: flipLastBase64Char(envelope.data.tag) },
    };
    expect(() => crypto.decrypt(tampered, author.uuid, author.encryptionKeyPair)).toThrow(
      CryptoError,
    );
  });

  it('uses a fresh content key and nonce per encrypt', () => {
    // Every publish rotates the CEK — that is what makes revoke work at all.
    const a = crypto.encrypt(utf8('same'), [recipientFor(author)]);
    const b = crypto.encrypt(utf8('same'), [recipientFor(author)]);
    expect(a.data.iv).not.toBe(b.data.iv);
    expect(a.data.ciphertext).not.toBe(b.data.ciphertext);
    expect(a.keys[author.uuid]).not.toBe(b.keys[author.uuid]);
  });

  it('splits the ciphertext and tag the way the wire expects', () => {
    const plaintext = utf8('twelve bytes');
    const envelope = crypto.encrypt(plaintext, [recipientFor(author)]);
    expect(Buffer.from(envelope.data.iv, 'base64')).toHaveLength(24);
    expect(Buffer.from(envelope.data.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.data.ciphertext, 'base64')).toHaveLength(plaintext.length);
  });

  it('encrypts an empty payload', () => {
    const envelope = crypto.encrypt(new Uint8Array(0), [recipientFor(author)]);
    expect(crypto.decrypt(envelope, author.uuid, author.encryptionKeyPair)).toHaveLength(0);
  });
});

describe('identityFromSeed', () => {
  it('is deterministic and yields the documented key sizes', () => {
    const again = identityFromSeed(seedOf(0), sodium);
    expect(again.uuid).toBe(author.uuid);
    expect(Buffer.from(again.signPublicKey).toString('hex')).toBe(
      Buffer.from(author.signPublicKey).toString('hex'),
    );
    expect(author.signPublicKey).toHaveLength(32);
    expect(author.signingKeyPair.secretKey).toHaveLength(64);
    expect(author.encPublicKey).toHaveLength(32);
    expect(author.encryptionKeyPair.secretKey).toHaveLength(32);
  });

  it('keeps the signing and encryption keypairs distinct', () => {
    expect(Buffer.from(author.signPublicKey).toString('hex')).not.toBe(
      Buffer.from(author.encPublicKey).toString('hex'),
    );
  });
});

/** Change one base64 character to something else in the same alphabet. */
function flipLastBase64Char(s: string): string {
  const stripped = s.replace(/=+$/, '');
  const last = stripped.at(-1)!;
  const replacement = last === 'A' ? 'B' : 'A';
  return stripped.slice(0, -1) + replacement + s.slice(stripped.length);
}
