import { beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import { identityFromSeed, type Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { DecodeError } from '../src/sync/json.js';
import {
  decodeEnvelope,
  decodeErrorCode,
  decodeShoppingListView,
  decodeUserProfile,
  envelopeToWire,
} from '../src/sync/wire.js';

/**
 * The wire boundary.
 *
 * The Android client gets shape-checking free from `kotlinx.serialization`; TypeScript's
 * types are erased, so `JSON.parse() as UserProfileDto` would assert a shape rather
 * than check one. That matters here more than in most clients: an `undefined` where a
 * base64 key belongs travels straight into a signature computation or a `Buffer.from`
 * and fails somewhere unrecognisable. These tests pin that it fails at the boundary.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let author: Identity;

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  author = identityFromSeed(
    Uint8Array.from({ length: 64 }, (_, i) => i),
    sodium,
  );
});

describe('envelope wire mapping', () => {
  it('round-trips a sealed envelope with its base64 fields verbatim', () => {
    // The server recomputes the signature over exactly these strings, so a re-encode
    // anywhere in this path would produce envelopes it answers with `bad_signature`.
    const sealed = crypto.seal(
      'cards',
      author.uuid,
      2,
      new Uint8Array(Buffer.from('cards', 'utf8')),
      [{ uuid: author.uuid, x25519PublicKey: author.encPublicKey }],
      author.uuid,
      author.signingKeyPair.secretKey,
    );
    const reread = decodeEnvelope(JSON.stringify(envelopeToWire(sealed)));
    expect(reread).toEqual(sealed);
    expect(crypto.verify('cards', author.uuid, reread, author.signPublicKey)).toBe(true);
  });

  it('reads an absent key map and an unsigned body', () => {
    const envelope = decodeEnvelope('{"data":{"iv":"a","ciphertext":"b","tag":"c"}}');
    expect(envelope.keys).toEqual({});
    expect(envelope.signature).toBeUndefined();
  });

  it('ignores fields the server has grown', () => {
    const envelope = decodeEnvelope(
      '{"data":{"iv":"a","ciphertext":"b","tag":"c","future":1},"unknown":true}',
    );
    expect(envelope.data.iv).toBe('a');
  });

  it('rejects a body missing or mistyping a field the crypto depends on', () => {
    expect(() => decodeEnvelope('{"data":{"iv":"a","ciphertext":"b"}}')).toThrow(DecodeError);
    expect(() => decodeEnvelope('{"data":{"iv":1,"ciphertext":"b","tag":"c"}}')).toThrow(
      DecodeError,
    );
    expect(() =>
      decodeEnvelope('{"data":{"iv":"a","ciphertext":"b","tag":"c"},"keys":{"u":7}}'),
    ).toThrow(DecodeError);
    expect(() =>
      decodeEnvelope(
        '{"data":{"iv":"a","ciphertext":"b","tag":"c"},"signature":{"by":"u","sig":"s"}}',
      ),
    ).toThrow(DecodeError);
    expect(() => decodeEnvelope('[]')).toThrow(DecodeError);
    expect(() => decodeEnvelope('nonsense')).toThrow(DecodeError);
  });
});

describe('user profile and list decoding', () => {
  it('reads a profile and treats an absent encrypted name as absent', () => {
    expect(decodeUserProfile('{"signKey":"SK","encKey":"EK","ver":3}')).toEqual({
      signKey: 'SK',
      encKey: 'EK',
      displayNameEnc: null,
      ver: 3,
    });
  });

  it('rejects a profile without the keys it exists to carry', () => {
    expect(() => decodeUserProfile('{"encKey":"EK","ver":3}')).toThrow(DecodeError);
    expect(() => decodeUserProfile('{"signKey":"SK","encKey":"EK","ver":"3"}')).toThrow(
      DecodeError,
    );
  });

  it('reads every author’s slice of a list', () => {
    const view = decodeShoppingListView(
      JSON.stringify({
        listId: 'list-1',
        slices: [
          { authorUuid: 'a', ver: 2, envelope: { data: { iv: 'i', ciphertext: 'c', tag: 't' } } },
          { authorUuid: 'b', ver: 5, envelope: { data: { iv: 'I', ciphertext: 'C', tag: 'T' } } },
        ],
      }),
    );
    expect(view.slices.map((s) => s.authorUuid)).toEqual(['a', 'b']);
    expect(view.slices[1]!.ver).toBe(5);
  });

  it('names the slice that was malformed', () => {
    expect(() =>
      decodeShoppingListView('{"listId":"l","slices":[{"authorUuid":"a","ver":1}]}'),
    ).toThrow(/slices\[0\]\.envelope/);
  });
});

describe('error bodies', () => {
  it('reads the machine-readable code when there is one', () => {
    expect(decodeErrorCode('{"error":"stale_version"}')).toBe('stale_version');
  });

  it('shrugs at anything else rather than masking the status', () => {
    expect(decodeErrorCode('<html>502</html>')).toBeNull();
    expect(decodeErrorCode('{}')).toBeNull();
    expect(decodeErrorCode('')).toBeNull();
  });
});
