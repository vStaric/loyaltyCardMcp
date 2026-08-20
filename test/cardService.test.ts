import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CardInputError,
  CardNotFoundError,
  CardNotOursError,
  CardService,
  CardStoreError,
} from '../src/cards/cardService.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import type { Connection, ResourceScope } from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { decodeCardsSnapshot } from '../src/sync/cardSnapshot.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import { FakeBackend, cardOf, identityOf, publishCardsAs } from './support/fakeBackend.js';

/**
 * The card tool surface's behaviour, against an in-memory backend holding two real
 * identities: this agent, and a user who shares with it.
 *
 * Three properties are load-bearing and each has its own test below:
 *
 * 1. **The refusal is explicit.** A user who withheld the cards scope publishes an
 *    envelope with no key wrapped to us. That must surface as a named refusal, never as
 *    an empty card list — "you have no cards" would be a lie about the user's data.
 * 2. **The ownership error names the reason.** An agent that reported a successful edit
 *    which did not happen is worse than one that refuses (bead lcm-ffs).
 * 3. **A read this peer cannot make sense of never becomes an empty write.** The write
 *    path republishes the whole blob, so a degraded read is a data-loss bug.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let agent: Identity;
let user: Identity;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  agent = identityOf(sodium, 1);
  user = identityOf(sodium, 2);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function connectionTo(
  identity: Identity,
  scopes: readonly ResourceScope[] = ['cards'],
): Connection {
  return {
    uuid: identity.uuid,
    displayName: 'Vid',
    signKey: b64(identity.signPublicKey),
    encKey: b64(identity.encPublicKey),
    scopes,
    kind: 'person',
    connectedAt: 0,
  };
}

interface Harness {
  readonly backend: FakeBackend;
  readonly service: CardService;
  readonly roster: RosterStore;
}

function harness(connections: readonly Connection[] = [], now = () => 1_800_000_000_000): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-cards-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  if (connections.length > 0) roster.save({ connections, handledRequestIds: [] });
  let seq = 0;
  const service = new CardService(agent, backend, crypto, new SyncStateStore(dir), roster, {
    now,
    newId: () => `new-card-${++seq}`,
  });
  return { backend, service, roster };
}

/** What the agent's own published blob currently holds, decrypted with its own key. */
function ownCards(backend: FakeBackend) {
  const stored = backend.cards.get(agent.uuid);
  if (!stored) return null;
  const plaintext = crypto.decrypt(stored.envelope, agent.uuid, agent.encryptionKeyPair);
  return decodeCardsSnapshot(Buffer.from(plaintext).toString('utf8')).cards;
}

describe('reading', () => {
  it('merges the user’s cards with the agent’s own, attributing each', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    publishCardsAs(
      backend,
      crypto,
      user,
      [cardOf({ id: 'u1', title: 'User card' })],
      [user, agent],
    );
    await service.add({ title: 'Agent card' });

    const view = await service.view();
    expect(view.unreadable).toEqual([]);
    expect(view.cards.map((m) => [m.card.title, m.provenance.kind])).toEqual([
      ['Agent card', 'own'],
      ['User card', 'sharedBy'],
    ]);
  });

  it('names the refusal when the user granted this agent the list but not the cards', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    // The user's app published its cards sealed to itself alone — the shape of a
    // connection scoped to `shopping` only (lc-chp).
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Secret' })], [user]);

    const view = await service.view();
    expect(view.cards).toEqual([]);
    expect(view.unreadable).toHaveLength(1);
    expect(view.unreadable[0]).toMatchObject({ uuid: user.uuid, reason: 'not_granted' });
    expect(view.unreadable[0]!.detail).toContain('cannot be read, not merely not shown');
  });

  it('says "not published" when the account has no cards blob at all', async () => {
    const { service } = harness([connectionTo(user)]);
    const view = await service.view();
    expect(view.unreadable[0]).toMatchObject({ reason: 'not_published' });
  });

  it('refuses a card list signed by anyone but the connection it came from', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    const impostor = identityOf(sodium, 3);
    // The server hands back an envelope at the user's address that the impostor signed.
    const envelope = crypto.seal(
      'cards',
      user.uuid,
      1,
      Buffer.from('{}', 'utf8'),
      [{ uuid: agent.uuid, x25519PublicKey: agent.encPublicKey }],
      impostor.uuid,
      impostor.signingKeyPair.secretKey,
    );
    backend.cards.set(user.uuid, { envelope, ver: 1 });

    const view = await service.view();
    expect(view.cards).toEqual([]);
    expect(view.unreadable[0]).toMatchObject({ reason: 'not_verified' });
  });

  it('refuses a card list that does not verify against the PINNED key', async () => {
    // The roster pins the user's real key; the backend serves a list signed by a key it
    // swapped in. This is the substitution the pin exists to catch.
    const swapped = identityOf(sodium, 4);
    const pinned = { ...connectionTo(user), signKey: b64(swapped.signPublicKey) };
    const { backend, service } = harness([pinned]);
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'x' })], [user, agent]);

    const view = await service.view();
    expect(view.unreadable[0]).toMatchObject({ reason: 'not_verified' });
  });

  it('reports a failed fetch as unreachable rather than as an empty list', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    backend.unreachableCards.add(user.uuid);
    const view = await service.view();
    expect(view.unreadable[0]).toMatchObject({ reason: 'unreachable' });
  });

  it('counts connections, so "nobody has accepted me" stays distinguishable', async () => {
    expect((await harness().service.view()).connectionCount).toBe(0);
    expect((await harness([connectionTo(user)]).service.view()).connectionCount).toBe(1);
  });
});

describe('adding', () => {
  it('publishes the card and seals it to every connection granted the cards scope', async () => {
    const listOnly = identityOf(sodium, 5);
    const { backend, service } = harness([
      connectionTo(user, ['cards']),
      { ...connectionTo(listOnly, ['shopping']), displayName: 'Shopping only' },
    ]);

    const card = await service.add({ title: 'Cafe', barcodeValue: '123', barcodeFormat: 'EAN_13' });

    expect(card).toMatchObject({ title: 'Cafe', barcodeValue: '123', barcodeFormat: 'EAN_13' });
    const keys = Object.keys(backend.cards.get(agent.uuid)!.envelope.keys).sort();
    expect(keys).toEqual([agent.uuid, user.uuid].sort());
    // A peer granted only the shopping list is not handed a key it could open.
    expect(keys).not.toContain(listOnly.uuid);
  });

  it('appends rather than replacing, and keeps sort order climbing', async () => {
    const { backend, service } = harness();
    await service.add({ title: 'First' });
    await service.add({ title: 'Second' });
    expect(ownCards(backend)!.map((c) => [c.title, c.sortOrder])).toEqual([
      ['First', 0],
      ['Second', 1],
    ]);
  });

  it('refuses a barcode value with no format — it would not dedup in the grid', async () => {
    const { service } = harness();
    await expect(service.add({ title: 'Cafe', barcodeValue: '123' })).rejects.toBeInstanceOf(
      CardInputError,
    );
  });

  it('refuses a format this app cannot draw', async () => {
    const { service } = harness();
    await expect(
      service.add({ title: 'Cafe', barcodeValue: '123', barcodeFormat: 'AZTEC' }),
    ).rejects.toThrow(/unknown barcodeFormat/);
  });

  it('refuses a card with no title', async () => {
    const { service } = harness();
    await expect(service.add({ title: '   ' })).rejects.toBeInstanceOf(CardInputError);
  });

  it('does not lose a card when two adds are in flight at once', async () => {
    const { backend, service } = harness();
    await Promise.all([service.add({ title: 'A' }), service.add({ title: 'B' })]);
    expect(
      ownCards(backend)!
        .map((c) => c.title)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('retries above the server’s version when another writer moved it', async () => {
    const { backend, service } = harness();
    // Something already published version 5 of this agent's blob; the local store still
    // believes it is at 0, which is exactly the state a restarted process is in.
    publishCardsAs(backend, crypto, agent, [], [agent], 5);
    await service.add({ title: 'After the conflict' });
    expect(backend.cards.get(agent.uuid)!.ver).toBe(6);
    expect(ownCards(backend)!.map((c) => c.title)).toEqual(['After the conflict']);
  });
});

describe('editing and deleting the agent’s own cards', () => {
  it('changes only the fields named, and moves updatedAt', async () => {
    const { service } = harness();
    const card = await service.add({ title: 'Cafe', notes: 'old' });
    const updated = await service.update(card.id, { title: 'Cafe Nero' });
    expect(updated).toMatchObject({ title: 'Cafe Nero', notes: 'old' });
    expect(updated.updatedAt).toBe(1_800_000_000_000);
  });

  it('clears a field on an explicit null', async () => {
    const { service } = harness();
    const card = await service.add({ title: 'Cafe', notes: 'old' });
    expect((await service.update(card.id, { notes: null })).notes).toBeNull();
  });

  it('carries photo pointers through an edit rather than dropping them', async () => {
    // A card this agent authored on another host, complete with a photo.
    const { backend, service } = harness();
    publishCardsAs(
      backend,
      crypto,
      agent,
      [
        cardOf({
          id: 'c1',
          title: 'Cafe',
          photos: {
            front: { hash: 'h', key: 'azE=' },
            back: null,
            logo: null,
            frontCleared: null,
            backCleared: true,
            logoCleared: null,
          },
        }),
      ],
      [agent],
    );

    const updated = await service.update('c1', { title: 'Cafe Nero' });
    expect(updated.photos.front).toEqual({ hash: 'h', key: 'azE=' });
    expect(updated.photos.backCleared).toBe(true);
  });

  it('deletes outright — a single-author blob needs no tombstone', async () => {
    const { backend, service } = harness();
    const card = await service.add({ title: 'Cafe' });
    await service.add({ title: 'Keep me' });
    await service.remove(card.id);
    expect(ownCards(backend)!.map((c) => c.title)).toEqual(['Keep me']);
  });
});

describe('the cards it may not touch', () => {
  it('refuses to edit the user’s card, naming the owner and the reason', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Theirs' })], [user, agent]);

    const error = await service.update('u1', { title: 'Mine now' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CardNotOursError);
    expect((error as Error).message).toContain('cards belong to the account that created them');
    expect((error as Error).message).toContain('Vid');
    // And nothing was written while failing.
    expect(backend.cardPuts).toBe(0);
  });

  it('refuses to delete the user’s card', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Theirs' })], [user, agent]);
    await expect(service.remove('u1')).rejects.toBeInstanceOf(CardNotOursError);
    expect(backend.cardPuts).toBe(0);
  });

  it('says not-found for an id nobody holds', async () => {
    const { service } = harness();
    await expect(service.update('nope', { title: 'x' })).rejects.toBeInstanceOf(CardNotFoundError);
  });
});

describe('protecting the agent’s own blob', () => {
  it('refuses to overwrite a blob it cannot verify as its own', async () => {
    const { backend, service } = harness();
    const impostor = identityOf(sodium, 6);
    backend.cards.set(agent.uuid, {
      envelope: crypto.seal(
        'cards',
        agent.uuid,
        1,
        Buffer.from('{}', 'utf8'),
        [{ uuid: agent.uuid, x25519PublicKey: agent.encPublicKey }],
        impostor.uuid,
        impostor.signingKeyPair.secretKey,
      ),
      ver: 1,
    });

    await expect(service.add({ title: 'Cafe' })).rejects.toBeInstanceOf(CardStoreError);
    expect(backend.cardPuts).toBe(0);
  });

  it('refuses to overwrite a blob written under a different recovery phrase', async () => {
    const { backend, service } = harness();
    // Correctly signed by this uuid, but sealed to a key this host does not hold — the
    // shape of an identity imported from a different phrase.
    const stranger = identityOf(sodium, 7);
    backend.cards.set(agent.uuid, {
      envelope: crypto.seal(
        'cards',
        agent.uuid,
        1,
        Buffer.from('{}', 'utf8'),
        [{ uuid: stranger.uuid, x25519PublicKey: stranger.encPublicKey }],
        agent.uuid,
        agent.signingKeyPair.secretKey,
      ),
      ver: 1,
    });

    await expect(service.view()).rejects.toBeInstanceOf(CardStoreError);
    expect(backend.cardPuts).toBe(0);
  });
});

describe('republish', () => {
  it('re-wraps the same cards to a newly accepted connection', async () => {
    const { backend, service, roster } = harness();
    await service.add({ title: 'Cafe' });
    roster.save({ connections: [connectionTo(user)], handledRequestIds: [] });

    await service.republish();

    expect(Object.keys(backend.cards.get(agent.uuid)!.envelope.keys).sort()).toEqual(
      [agent.uuid, user.uuid].sort(),
    );
    expect(ownCards(backend)!.map((c) => c.title)).toEqual(['Cafe']);
  });

  it('rotates a revoked connection out of the recipient set', async () => {
    const { backend, service, roster } = harness([connectionTo(user)]);
    await service.add({ title: 'Cafe' });
    roster.save({ connections: [], handledRequestIds: [] });

    await service.republish();

    expect(Object.keys(backend.cards.get(agent.uuid)!.envelope.keys)).toEqual([agent.uuid]);
  });
});
