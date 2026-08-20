import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { mnemonicToSeed } from '../src/crypto/bip39.js';
import type { Envelope, EnvelopeData } from '../src/crypto/envelope.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import { deriveIdentitySecrets } from '../src/crypto/identityDeriver.js';
import {
  CryptoError,
  initSodium,
  type SodiumCrypto,
  type SodiumKeyPair,
} from '../src/crypto/sodium.js';

/**
 * The shared **envelope crypto** vectors (`test-vectors/envelope-crypto.json`), run
 * against this peer's `EnvelopeCrypto` and `IdentityDeriver`.
 *
 * `envelopeCrypto.test.ts` next door exercises the same surface, but every envelope it
 * opens is one it just sealed. That shape cannot see the failure this file exists for:
 * if this implementation's AEAD, key wrapping or identity derivation drifts from the
 * app's, both sides still round-trip perfectly against themselves and every suite in
 * every repo stays green. The server never decrypts, so the one component that sees
 * both peers is blind to this class **by design** — the defect first surfaces as a real
 * Android user who cannot open a list this agent sealed.
 *
 * So the vectors are fixed artefacts: a ciphertext, a key map and a recipient secret
 * written down once, with the plaintext they must produce. A second implementation that
 * cannot reproduce them has already drifted. Signatures are pinned the same way —
 * Ed25519 detached signatures are deterministic, so the sign vectors collapse the
 * signed-byte layout, the recipient ordering and the key derivation into one literal.
 *
 * As with the merge vectors, assertions belong in the JSON: anything phrased here in
 * TypeScript is a rule the app is not held to. The exception is the coverage guard at
 * the bottom, which asserts about the vector FILE rather than about the crypto.
 */

interface IdentityVector {
  readonly role: string;
  readonly mnemonic: string;
  readonly bip39Seed: string;
  readonly uuid: string;
  readonly ed25519Seed: string;
  readonly x25519Seed: string;
  readonly ed25519PublicKey: string;
  readonly ed25519SecretKey: string;
  readonly x25519PublicKey: string;
  readonly x25519SecretKey: string;
}

interface Named {
  readonly name: string;
  readonly why: string;
}

interface OpenVector extends Named {
  readonly recipient: string;
  readonly envelope: Envelope;
  readonly plaintextBase64: string;
}

/**
 * `failure` is the neutral spelling of *why* it must not open. Each side maps it onto
 * whatever its own crypto layer throws — the same arrangement the merge vectors use for
 * provenance — because the category is part of the contract, not a detail of the
 * message. "Does not open" is too weak to hold both sides to: a permissive base64
 * decoder also fails to open a malformed envelope, just as an authentication failure,
 * so the two clients would disagree about what a user is even looking at.
 */
type Failure = 'no-wrapped-key' | 'malformed-base64' | 'authentication';

interface OpenFailVector extends Named {
  readonly recipient: string;
  readonly envelope: Envelope;
  readonly failure: Failure;
}

interface SignVector extends Named {
  readonly signer: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly ver: number;
  readonly data: EnvelopeData;
  readonly keys: Readonly<Record<string, string>>;
  readonly expectedSignatureBase64: string;
}

interface VerifyVector extends Named {
  readonly author: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly envelope: Envelope;
  readonly expected: boolean;
}

interface VectorFile {
  readonly v: number;
  readonly kind: string;
  readonly identities: Readonly<Record<string, IdentityVector>>;
  readonly open: readonly OpenVector[];
  readonly openFails: readonly OpenFailVector[];
  readonly sign: readonly SignVector[];
  readonly verify: readonly VerifyVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../test-vectors/envelope-crypto.json', import.meta.url), 'utf8'),
) as VectorFile;

// A vector file that declared a schema or a subject this harness does not implement
// would otherwise be run under rules it was not written for.
expect(vectors.v, 'envelope-crypto.json schema version').toBe(1);
expect(vectors.kind, 'envelope-crypto.json subject').toBe('envelope-crypto');

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function identity(label: string): IdentityVector {
  const found = vectors.identities[label];
  expect(found, `vector names identity "${label}"`).toBeDefined();
  return found!;
}

/**
 * The recipient's X25519 keypair as the **file** states it, not as this side derives
 * it. Deriving here would fold two seams into one: a decrypt failure could then mean
 * either the wrapping drifted or the derivation did. The identity vectors below pin
 * the derivation on its own, so a real drift names itself.
 */
function encryptionKeyPair(label: string): SodiumKeyPair {
  const id = identity(label);
  return { publicKey: bytes(id.x25519PublicKey), secretKey: bytes(id.x25519SecretKey) };
}

let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
});

describe('envelope-crypto identity vectors', () => {
  it.each(Object.entries(vectors.identities))('%s derives to the pinned account', (label, id) => {
    expect(Buffer.from(mnemonicToSeed(id.mnemonic)).toString('hex'), `${label} bip39 seed`).toBe(
      id.bip39Seed,
    );

    const secrets = deriveIdentitySecrets(bytes(id.bip39Seed));
    expect(secrets.uuid, `${label} uuid`).toBe(id.uuid);
    expect(Buffer.from(secrets.ed25519Seed).toString('hex'), `${label} ed25519 seed`).toBe(
      id.ed25519Seed,
    );
    expect(Buffer.from(secrets.x25519Seed).toString('hex'), `${label} x25519 seed`).toBe(
      id.x25519Seed,
    );

    // The public halves are what a peer publishes and what everyone else wraps to, so
    // the vector pins them rather than trusting that two libsodium builds agree.
    const signing = sodium.ed25519KeyPairFromSeed(secrets.ed25519Seed);
    expect(Buffer.from(signing.publicKey).toString('hex'), `${label} ed25519 public`).toBe(
      id.ed25519PublicKey,
    );
    expect(Buffer.from(signing.secretKey).toString('hex'), `${label} ed25519 secret`).toBe(
      id.ed25519SecretKey,
    );

    const encryption = sodium.x25519KeyPairFromSeed(secrets.x25519Seed);
    expect(Buffer.from(encryption.publicKey).toString('hex'), `${label} x25519 public`).toBe(
      id.x25519PublicKey,
    );
    expect(Buffer.from(encryption.secretKey).toString('hex'), `${label} x25519 secret`).toBe(
      id.x25519SecretKey,
    );
  });
});

describe('envelope-crypto open vectors', () => {
  it.each(vectors.open.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const plaintext = crypto.decrypt(
      v.envelope,
      identity(v.recipient).uuid,
      encryptionKeyPair(v.recipient),
    );
    expect(b64(plaintext)).toBe(v.plaintextBase64);
  });
});

/**
 * This side's spelling of each {@link Failure}. `EnvelopeCrypto` reports the two
 * structured ones with the exact messages `EnvelopeCrypto.kt` uses, so the mapping is
 * a prefix match; anything else it raises is the crypto primitives refusing, which is
 * the authentication category.
 */
function failureOf(error: unknown): Failure {
  expect(error, 'decrypt failed with a CryptoError').toBeInstanceOf(CryptoError);
  const message = (error as CryptoError).message;
  if (message.startsWith('no wrapped key for recipient')) return 'no-wrapped-key';
  if (message.startsWith('malformed base64 in envelope')) return 'malformed-base64';
  return 'authentication';
}

describe('envelope-crypto open-failure vectors', () => {
  it.each(vectors.openFails.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    let thrown: unknown;
    try {
      crypto.decrypt(v.envelope, identity(v.recipient).uuid, encryptionKeyPair(v.recipient));
      expect.unreachable(`${v.name} opened, and must not`);
    } catch (e) {
      thrown = e;
    }
    expect(failureOf(thrown)).toBe(v.failure);
  });
});

describe('envelope-crypto sign vectors', () => {
  it.each(vectors.sign.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const signer = identity(v.signer);
    const signed = crypto.sign(
      v.resourceType,
      v.resourceId,
      v.ver,
      { data: v.data, keys: v.keys },
      signer.uuid,
      bytes(signer.ed25519SecretKey),
    );
    expect(signed.signature?.sig).toBe(v.expectedSignatureBase64);
    expect(signed.signature?.by).toBe(signer.uuid);
    expect(signed.signature?.ver).toBe(v.ver);
  });
});

describe('envelope-crypto verify vectors', () => {
  it.each(vectors.verify.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(
      crypto.verify(
        v.resourceType,
        v.resourceId,
        v.envelope,
        bytes(identity(v.author).ed25519PublicKey),
      ),
    ).toBe(v.expected);
  });
});

/**
 * Guards about the vector file itself. The open vectors are the ones that answer
 * `lcm-c46` — a cross-implementation pin on the seam that carries user data — so
 * losing them silently is the failure this list prevents. Deleting one is allowed, but
 * only deliberately, by editing this list in the same commit.
 */
describe('coverage', () => {
  it('still carries a decrypt vector for each payload shape that has its own failure mode', () => {
    const names = new Set(vectors.open.map((v) => v.name));
    for (const required of [
      'a-two-recipient-shopping-list-opens-for-its-author',
      'the-same-envelope-opens-for-the-second-recipient',
      'an-empty-payload-opens-to-zero-bytes',
      'every-byte-value-survives-the-payload-path',
      'non-ascii-item-names-open-unchanged',
    ]) {
      expect(names, `open vector "${required}"`).toContain(required);
    }
  });

  it('exercises every failure category a reader has to tell apart', () => {
    expect([...new Set(vectors.openFails.map((v) => v.failure))].sort()).toEqual([
      'authentication',
      'malformed-base64',
      'no-wrapped-key',
    ]);
  });

  it('pins at least one signature as a literal', () => {
    expect(vectors.sign.length).toBeGreaterThan(0);
    for (const v of vectors.sign) {
      expect(Buffer.from(v.expectedSignatureBase64, 'base64'), v.name).toHaveLength(64);
    }
  });

  it('keeps a true case among the verify vectors, so the negatives mean something', () => {
    expect(vectors.verify.some((v) => v.expected)).toBe(true);
    expect(vectors.verify.some((v) => !v.expected)).toBe(true);
  });

  it('names every vector uniquely and says what each is for', () => {
    const named: readonly Named[] = [
      ...vectors.open,
      ...vectors.openFails,
      ...vectors.sign,
      ...vectors.verify,
    ];
    expect(new Set(named.map((v) => v.name)).size).toBe(named.length);
    for (const vector of named) {
      expect(vector.why.length, `${vector.name} explains itself`).toBeGreaterThan(0);
    }
  });
});
