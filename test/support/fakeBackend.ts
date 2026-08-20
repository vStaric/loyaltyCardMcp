import type { Envelope } from '../../src/crypto/envelope.js';
import { EnvelopeCrypto } from '../../src/crypto/envelopeCrypto.js';
import { identityFromSeed, type Identity } from '../../src/crypto/identity.js';
import type { SodiumCrypto } from '../../src/crypto/sodium.js';
import { StaleVersionError } from '../../src/sync/apiError.js';
import { encodeCardsSnapshot } from '../../src/sync/cardSnapshot.js';
import type { TolarApi } from '../../src/sync/tolarApi.js';
import type {
  SliceViewDto,
  PairingCodeIssuedDto,
  PairingCodeResolvedDto,
  ShareRequestsViewDto,
  ShareRequestViewDto,
  ShareResponseViewDto,
  ShoppingListViewDto,
  UserProfileDto,
  UserPutBody,
} from '../../src/sync/wire.js';
import type { Card } from '../../src/cards/card.js';
import {
  encodeShoppingSnapshotBytes,
  type ShoppingListSnapshot,
} from '../../src/shopping/snapshot.js';

/**
 * An in-memory Tolar backend with the two rules that make the card tests mean
 * anything: a write must be **strictly version-increasing**, and the stored envelope
 * comes back **verbatim**.
 *
 * Without the first, the reconcile path never runs. Without the second, a test could
 * pass on an envelope this fake helpfully repaired — and the whole point of the card
 * layer is what it does with envelopes it cannot open or verify.
 */
export class FakeBackend implements TolarApi {
  readonly users = new Map<string, UserProfileDto>();
  readonly cards = new Map<string, { envelope: Envelope; ver: number }>();
  readonly shares = new Map<string, { envelope: Envelope; ver: number }>();
  requests: ShareRequestViewDto[] = [];
  /** Counts every card PUT, so a test can prove a write happened exactly once. */
  cardPuts = 0;
  /** Accounts whose card reads fail, to exercise the unreachable path. */
  readonly unreachableCards = new Set<string>();
  /** Shopping-list slices, keyed by list id — each author publishes into their own. */
  readonly slices = new Map<string, SliceViewDto[]>();
  /** Counts every slice PUT, so a test can prove a write happened exactly once. */
  slicePuts = 0;
  /** Lists whose reads fail, to exercise the unreachable path. */
  readonly unreachableLists = new Set<string>();
  /** The content-addressed blob store: photo ciphertext, keyed by its address. */
  readonly blobs = new Map<string, Uint8Array>();
  /** Blobs whose fetch fails, to exercise the unreachable path. */
  readonly unreachableBlobs = new Set<string>();

  async getUser(uuid: string): Promise<UserProfileDto | null> {
    return this.users.get(uuid) ?? null;
  }

  async putUser(uuid: string, body: UserPutBody, ver: number): Promise<number> {
    this.users.set(uuid, {
      signKey: body.signKey,
      encKey: body.encKey,
      displayNameEnc: body.displayNameEnc ?? null,
      ver,
    });
    return ver;
  }

  async getCards(uuid: string): Promise<Envelope | null> {
    if (this.unreachableCards.has(uuid)) throw new Error('backend unavailable');
    return this.cards.get(uuid)?.envelope ?? null;
  }

  async putCards(uuid: string, envelope: Envelope): Promise<number> {
    this.cardPuts++;
    return put(this.cards, uuid, envelope);
  }

  async getShare(uuid: string): Promise<Envelope | null> {
    return this.shares.get(uuid)?.envelope ?? null;
  }

  async putShare(uuid: string, envelope: Envelope): Promise<number> {
    return put(this.shares, uuid, envelope);
  }

  async getRequestShare(): Promise<ShareRequestsViewDto> {
    return { originUuid: '', requests: this.requests };
  }

  async getShoppingList(listId: string): Promise<ShoppingListViewDto> {
    if (this.unreachableLists.has(listId)) throw new Error('backend unavailable');
    return { listId, slices: this.slices.get(listId) ?? [] };
  }

  /**
   * Store one author's slice under `listId`, enforcing the same strictly-increasing
   * version the cards blob gets. A slice is per (list, author), so a second author
   * writing into the same list joins it rather than replacing what is there.
   */
  async putShoppingSlice(listId: string, authorUuid: string, envelope: Envelope): Promise<number> {
    this.slicePuts++;
    const ver = envelope.signature?.ver ?? 0;
    const existing = this.slices.get(listId) ?? [];
    const current = existing.find((s) => s.authorUuid === authorUuid)?.ver ?? 0;
    if (ver <= current) throw new StaleVersionError();
    this.slices.set(listId, [
      ...existing.filter((s) => s.authorUuid !== authorUuid),
      { authorUuid, ver, envelope },
    ]);
    return ver;
  }

  /**
   * Store `bytes` at `hash` **without** re-deriving the address, so a test can seed a
   * blob that does not hash to the pointer naming it. The real server would refuse
   * that; the point of allowing it here is that the client must not trust it either.
   */
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(hash, bytes);
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    if (this.unreachableBlobs.has(hash)) throw new Error('backend unavailable');
    return this.blobs.get(hash) ?? null;
  }

  // --- not exercised by either tool surface ------------------------------------
  async deleteUser(): Promise<void> {}
  async postRequestShare(): Promise<number> {
    return 1;
  }
  async putShareResponse(): Promise<number> {
    return 1;
  }
  async getShareResponse(): Promise<ShareResponseViewDto | null> {
    return null;
  }
  async postPairingCode(): Promise<PairingCodeIssuedDto> {
    return { code: 'AAAA-BBBB', expiresAt: null, maxUses: 1 };
  }
  async postPairingResolve(): Promise<PairingCodeResolvedDto | null> {
    return null;
  }
}

function put(
  store: Map<string, { envelope: Envelope; ver: number }>,
  uuid: string,
  envelope: Envelope,
): number {
  const ver = envelope.signature?.ver ?? 0;
  const current = store.get(uuid)?.ver ?? 0;
  if (ver <= current) throw new StaleVersionError();
  store.set(uuid, { envelope, ver });
  return ver;
}

/** A deterministic identity, so a test can name the two sides and their key material. */
export function identityOf(sodium: SodiumCrypto, seedByte: number): Identity {
  return identityFromSeed(new Uint8Array(64).fill(seedByte), sodium);
}

/** Publish `cards` as `author`'s card blob, sealed to `recipients` — a peer's push. */
export function publishCardsAs(
  backend: FakeBackend,
  crypto: EnvelopeCrypto,
  author: Identity,
  cards: readonly Card[],
  recipients: readonly Identity[],
  ver = 1,
): Envelope {
  const envelope = crypto.seal(
    'cards',
    author.uuid,
    ver,
    Buffer.from(encodeCardsSnapshot(cards), 'utf8'),
    recipients.map((r) => ({ uuid: r.uuid, x25519PublicKey: r.encPublicKey })),
    author.uuid,
    author.signingKeyPair.secretKey,
  );
  backend.cards.set(author.uuid, { envelope, ver });
  return envelope;
}

/** Publish `slice` as `author`'s shopping-list slice, sealed to `recipients`. */
export function publishSliceAs(
  backend: FakeBackend,
  crypto: EnvelopeCrypto,
  author: Identity,
  slice: ShoppingListSnapshot,
  recipients: readonly Identity[],
  ver = 1,
): Envelope {
  const envelope = crypto.seal(
    'shoppinglist',
    `${author.uuid}::${author.uuid}`,
    ver,
    encodeShoppingSnapshotBytes(slice),
    recipients.map((r) => ({ uuid: r.uuid, x25519PublicKey: r.encPublicKey })),
    author.uuid,
    author.signingKeyPair.secretKey,
  );
  backend.slices.set(author.uuid, [{ authorUuid: author.uuid, ver, envelope }]);
  return envelope;
}

/** A card with sane defaults, so a test only spells out the field it is about. */
export function cardOf(fields: Partial<Card> & Pick<Card, 'id' | 'title'>): Card {
  return {
    notes: null,
    barcodeValue: null,
    barcodeFormat: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sortOrder: 0,
    photos: {
      front: null,
      back: null,
      logo: null,
      frontCleared: null,
      backCleared: null,
      logoCleared: null,
    },
    ...fields,
  };
}

export { EnvelopeCrypto };
