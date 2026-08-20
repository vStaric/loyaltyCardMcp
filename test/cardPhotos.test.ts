import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NO_PHOTOS, type CardPhotos } from '../src/cards/card.js';
import {
  CardPhotoError,
  CardPhotoService,
  DEFAULT_MAX_PHOTO_BYTES,
  ENV_MAX_PHOTO_BYTES,
  maxPhotoBytesFrom,
} from '../src/cards/cardPhotos.js';
import { CardService } from '../src/cards/cardService.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import type { Connection } from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import { FakeBackend, cardOf, identityOf, publishCardsAs } from './support/fakeBackend.js';
import { TINY_PNG, packPhoto } from './support/photos.js';

/**
 * Reading the bytes behind a card's photo pointer.
 *
 * The format itself is pinned in `imageCipher.test.ts`; what this file is about is the
 * three-way answer the service owes its caller. A photo can be *there*, *not there*, or
 * **there and not yet fetchable** — and the last one is the case worth the machinery: a
 * device publishes its card list before its blobs finish uploading, so "the card names a
 * photo the server does not hold" is a normal minute in the life of a healthy account.
 * Reporting it as "no photo" would contradict the card the same call just read.
 *
 * The other rule here is that integrity failures are loud. Bytes that are not at the
 * address they were fetched from, or that the card's own key will not open, throw —
 * never "no photo", which a caller would relay to a user as fact.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let agent: Identity;
let user: Identity;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  agent = identityOf(sodium, 31);
  user = identityOf(sodium, 32);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const connection = (): Connection => ({
  uuid: user.uuid,
  displayName: 'Vid',
  signKey: b64(user.signPublicKey),
  encKey: b64(user.encPublicKey),
  scopes: ['cards'],
  kind: 'person',
  connectedAt: 0,
});

function harness(maxBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-photos-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  roster.save({ connections: [connection()], handledRequestIds: [] });
  const cards = new CardService(agent, backend, crypto, new SyncStateStore(dir), roster, {
    now: () => 1_800_000_000_000,
    newId: () => 'agent-card',
  });
  const photos = new CardPhotoService(cards, backend, maxBytes ? { maxBytes } : {});
  return { backend, cards, photos };
}

describe('a photo the user shared', () => {
  it('comes back decrypted, typed, and at the address the card names', async () => {
    const { backend, photos } = harness();
    const packed = packPhoto();
    await backend.putBlob(packed.pointer.hash, packed.bytes);
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Bakery', photos: photosWith({ front: packed.pointer }) })],
      [user, agent],
    );

    const read = await photos.read('u1', 'front');
    if (!read.available) throw new Error(`expected the photo: ${read.detail}`);
    expect(Buffer.from(read.photo.bytes)).toEqual(Buffer.from(TINY_PNG));
    expect(read.photo.mediaType).toBe('image/png');
    expect(read.photo.hash).toBe(packed.pointer.hash);
    // The card travels with the bytes so a caller can say whose photo this is without
    // a second round trip.
    expect(read.card.card.title).toBe('Bakery');
  });

  it('hands back bytes it cannot name a type for, rather than withholding them', async () => {
    const { backend, photos } = harness();
    const packed = packPhoto(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await backend.putBlob(packed.pointer.hash, packed.bytes);
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Odd', photos: photosWith({ back: packed.pointer }) })],
      [user, agent],
    );

    const read = await photos.read('u1', 'back');
    if (!read.available) throw new Error('expected the bytes');
    expect(read.photo.mediaType).toBeNull();
    expect(read.photo.bytes.length).toBe(8);
  });
});

describe('when there are no bytes to give back', () => {
  it('separates a card nobody shared from a card with an empty slot', async () => {
    const { backend, photos } = harness();
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Plain' })], [user, agent]);

    const missing = await photos.read('nope', 'front');
    expect(missing).toMatchObject({ available: false, reason: 'no_such_card', card: null });

    const empty = await photos.read('u1', 'front');
    expect(empty).toMatchObject({ available: false, reason: 'no_photo' });
    if (empty.available) throw new Error('unreachable');
    expect(empty.detail).toBe('this card has no front photo');
    // The card comes back on the miss too: "your card has no back photo" needs the card.
    expect(empty.card?.card.title).toBe('Plain');
  });

  it('says a photo was removed when the author said so, and not otherwise (lc-mr9)', async () => {
    const { backend, photos } = harness();
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Was', photos: photosWith({ logoCleared: true }) })],
      [user, agent],
    );

    const read = await photos.read('u1', 'logo');
    if (read.available) throw new Error('expected a miss');
    expect(read.reason).toBe('no_photo');
    expect(read.detail).toBe("this card's logo photo was removed by its author");
  });

  it('reports a blob the server does not hold yet as pending, not as absent', async () => {
    const { backend, photos } = harness();
    const packed = packPhoto();
    // Card published, blob never uploaded — the ordinary race on a phone that syncs
    // its card list first.
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Soon', photos: photosWith({ front: packed.pointer }) })],
      [user, agent],
    );

    const read = await photos.read('u1', 'front');
    if (read.available) throw new Error('expected a miss');
    expect(read.reason).toBe('not_stored');
    expect(read.detail).toContain('does not hold it yet');
  });

  it('refuses a photo over the configured ceiling, naming the variable that raises it', async () => {
    const { backend, photos } = harness(32);
    const packed = packPhoto();
    await backend.putBlob(packed.pointer.hash, packed.bytes);
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Big', photos: photosWith({ front: packed.pointer }) })],
      [user, agent],
    );

    const read = await photos.read('u1', 'front');
    if (read.available) throw new Error('expected a refusal');
    expect(read.reason).toBe('too_large');
    expect(read.detail).toContain(ENV_MAX_PHOTO_BYTES);
  });
});

describe('bytes that are not what the card asked for', () => {
  it('throws when the store serves bytes that are not at the requested address', async () => {
    const { backend, photos } = harness();
    const packed = packPhoto();
    const other = packPhoto(new Uint8Array([9, 9, 9]));
    // A server that swapped one photo for another. The tag would catch this too, as a
    // decryption failure — which would read as "the owner's key is wrong".
    await backend.putBlob(packed.pointer.hash, other.bytes);
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Swapped', photos: photosWith({ front: packed.pointer }) })],
      [user, agent],
    );

    await expect(photos.read('u1', 'front')).rejects.toThrow(CardPhotoError);
    await expect(photos.read('u1', 'front')).rejects.toThrow(/is not the one the card names/);
  });

  it('throws when the key in the card does not open the blob', async () => {
    const { backend, photos } = harness();
    const packed = packPhoto();
    await backend.putBlob(packed.pointer.hash, packed.bytes);
    publishCardsAs(
      backend,
      crypto,
      user,
      [
        cardOf({
          id: 'u1',
          title: 'Wrong key',
          photos: photosWith({
            front: { hash: packed.pointer.hash, key: packPhoto().pointer.key },
          }),
        }),
      ],
      [user, agent],
    );

    await expect(photos.read('u1', 'front')).rejects.toThrow(/did not open with the key/);
  });

  it('lets a failed fetch surface, rather than reporting the photo as absent', async () => {
    const { backend, photos } = harness();
    const packed = packPhoto();
    backend.unreachableBlobs.add(packed.pointer.hash);
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'Offline', photos: photosWith({ front: packed.pointer }) })],
      [user, agent],
    );

    await expect(photos.read('u1', 'front')).rejects.toThrow('backend unavailable');
  });
});

describe('the size ceiling', () => {
  it("defaults to the backend's own per-blob limit, so no app photo is refused", () => {
    expect(maxPhotoBytesFrom({})).toBe(DEFAULT_MAX_PHOTO_BYTES);
    expect(DEFAULT_MAX_PHOTO_BYTES).toBe(2 * 1024 * 1024);
  });

  it('takes a host-set budget', () => {
    expect(maxPhotoBytesFrom({ [ENV_MAX_PHOTO_BYTES]: ' 65536 ' })).toBe(65536);
  });

  it('throws on a value it cannot honour instead of quietly serving the default', () => {
    // An operator who meant 200 KB and typed it wrong must not end up serving 2 MiB
    // and believing otherwise.
    expect(() => maxPhotoBytesFrom({ [ENV_MAX_PHOTO_BYTES]: '200kb' })).toThrow(
      ENV_MAX_PHOTO_BYTES,
    );
    expect(() => maxPhotoBytesFrom({ [ENV_MAX_PHOTO_BYTES]: '-1' })).toThrow();
  });
});

/** Card photo state with the named slots set and the rest silent. */
function photosWith(fields: Partial<CardPhotos>): CardPhotos {
  return { ...NO_PHOTOS, ...fields };
}
