import { beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import {
  SHARE_RESPONSE_TYPE,
  encodeShareResponse,
  sealShareResponse,
} from '../src/sharing/shareResponse.js';
import { identityOf } from './support/fakeBackend.js';

/**
 * The decision envelope a decline stores — a format this side only ever writes.
 *
 * Nothing here can fail visibly in this codebase: the reader is the app, which verifies
 * against the key it pinned and treats anything it cannot stand behind as "no answer".
 * A drift in the resource coordinates or the payload spelling would therefore surface
 * as a refusal the requester never learns about — silently indistinguishable from being
 * ignored, which is the one thing the whole document exists to prevent. So the seam is
 * pinned here, against `sync/sharing/ShareResponse.kt`.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let origin: Identity;
let requester: Identity;

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  origin = identityOf(sodium, 21);
  requester = identityOf(sodium, 22);
});

function recipient(identity: Identity) {
  return { uuid: identity.uuid, x25519PublicKey: identity.encPublicKey };
}

describe('the share-response payload', () => {
  it('spells the two fields the way the app deserializes them', () => {
    expect(JSON.parse(encodeShareResponse(42, false))).toEqual({ requestId: 42, accepted: false });
  });

  it('carries the decision as a boolean, with no third value for silence', () => {
    // An unanswered request has no stored row at all; that absence is what keeps
    // "ignored" distinguishable from "declined".
    expect(JSON.parse(encodeShareResponse(42, true))).toEqual({ requestId: 42, accepted: true });
  });
});

describe('sealing a decision', () => {
  it('binds it to the request it answers, at ver 0', () => {
    const envelope = sealShareResponse(crypto, origin, 42, false, recipient(requester));

    expect(envelope.signature?.by).toBe(origin.uuid);
    expect(envelope.signature?.ver).toBe(0);
    expect(crypto.verify(SHARE_RESPONSE_TYPE, '42', envelope, origin.signPublicKey)).toBe(true);
  });

  it('cannot be replayed onto another request', () => {
    // The id is in the signed coordinates, so lifting this envelope onto request 43
    // fails to verify — and the app reads that as no answer rather than as a decline.
    const envelope = sealShareResponse(crypto, origin, 42, false, recipient(requester));
    expect(crypto.verify(SHARE_RESPONSE_TYPE, '43', envelope, origin.signPublicKey)).toBe(false);
  });

  it('opens for the requester, and for nobody else', () => {
    const envelope = sealShareResponse(crypto, origin, 42, false, recipient(requester));

    const plaintext = crypto.decrypt(envelope, requester.uuid, requester.encryptionKeyPair);
    expect(JSON.parse(Buffer.from(plaintext).toString('utf8'))).toEqual({
      requestId: 42,
      accepted: false,
    });
    expect(Object.keys(envelope.keys)).toEqual([requester.uuid]);
  });
});
