import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import type { Connection, ResourceScope } from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { activeItems } from '../src/shopping/merge.js';
import { ShoppingService, ShoppingStoreError } from '../src/shopping/shoppingService.js';
import {
  decodeShoppingSnapshotBytes,
  type ShoppingListSnapshot,
} from '../src/shopping/snapshot.js';
import { addItems, createSection, setChecked } from '../src/shopping/writer.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import { FakeBackend, identityOf, publishSliceAs } from './support/fakeBackend.js';
import { item, section, snapshot } from './shoppingFixtures.js';

/**
 * The shopping resource layer, against an in-memory backend holding two real
 * identities: this agent, and a user who shares with it.
 *
 * Three properties are load-bearing, and they are the shopping-shaped versions of the
 * ones the card service pins:
 *
 * 1. **The refusal is explicit.** A user who withheld the shopping scope publishes a
 *    slice with no key wrapped to us. That must surface as a named refusal, never as an
 *    empty list — "you have nothing to buy" is a sentence they would act on.
 * 2. **The scope is enforced at the wrap.** A connection not granted the shopping list
 *    gets no content key, whatever any listing says.
 * 3. **A read this peer cannot make sense of never becomes an empty write.** Every write
 *    republishes our whole slice, so a degraded read is a data-loss bug.
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
  scopes: readonly ResourceScope[] = ['shopping'],
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
  readonly service: ShoppingService;
  readonly roster: RosterStore;
}

function harness(connections: readonly Connection[] = [], now = () => 1_800_000_000_000): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-shopping-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  if (connections.length > 0) roster.save({ connections, handledRequestIds: [] });
  let seq = 0;
  const service = new ShoppingService(agent, backend, crypto, new SyncStateStore(dir), roster, {
    now,
    newId: () => `new-item-${++seq}`,
  });
  return { backend, service, roster };
}

/** Our own published slice, opened the way the user's phone would open it. */
function publishedSlice(backend: FakeBackend, as: Identity = agent): ShoppingListSnapshot {
  const envelope = backend.slices.get(agent.uuid)?.[0]?.envelope;
  if (!envelope) throw new Error('nothing published');
  return decodeShoppingSnapshotBytes(crypto.decrypt(envelope, as.uuid, as.encryptionKeyPair));
}

describe('reading', () => {
  it('merges the user’s slice with our own', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    publishSliceAs(
      backend,
      crypto,
      user,
      snapshot([section('s', { title: 'Dairy' })], [item('milk', 's')]),
      [user, agent],
    );
    const view = await service.view();
    expect(view.list.sections[0]!.section.title).toBe('Dairy');
    expect(view.list.observedByPeers.has('milk')).toBe(true);
    expect(view.unreadable).toHaveLength(0);
  });

  it('names the refusal when a connection withheld the shopping list', async () => {
    // Their slice is published and verifies; it simply carries no key wrapped to us.
    const { backend, service } = harness([connectionTo(user, ['cards'])]);
    publishSliceAs(backend, crypto, user, snapshot([section('s')], [item('milk', 's')]), [user]);
    const view = await service.view();
    expect(view.list.sections).toHaveLength(0);
    expect(view.unreadable[0]).toMatchObject({ uuid: user.uuid, reason: 'not_granted' });
    expect(view.connectionCount).toBe(1);
  });

  it('reports a slice signed by a key other than the pinned one as unverified', async () => {
    // TOFU: the server is not trusted to say who anyone is, so a swapped key is a peer
    // we refuse rather than a peer we believe.
    const impostor = connectionTo(user);
    const { backend, service } = harness([{ ...impostor, signKey: b64(agent.signPublicKey) }]);
    publishSliceAs(backend, crypto, user, snapshot([section('s')], [item('milk', 's')]), [
      user,
      agent,
    ]);
    expect((await service.view()).unreadable[0]).toMatchObject({ reason: 'not_verified' });
  });

  it('reports an account that has published nothing as such', async () => {
    const { service } = harness([connectionTo(user)]);
    expect((await service.view()).unreadable[0]).toMatchObject({ reason: 'not_published' });
  });

  it('reports a fetch failure as unreachable rather than as an empty list', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    backend.unreachableLists.add(user.uuid);
    expect((await service.view()).unreadable[0]).toMatchObject({ reason: 'unreachable' });
  });
});

describe('writing', () => {
  it('publishes our slice sealed to every connection granted the shopping list', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    await seed(service, 'Dairy', ['Milk']);
    const keys = Object.keys(backend.slices.get(agent.uuid)![0]!.envelope.keys);
    expect(keys.sort()).toEqual([agent.uuid, user.uuid].sort());
    // And the user can actually open it — the point of the whole exercise.
    expect(publishedSlice(backend, user).items.map((i) => i.name)).toEqual(['Milk']);
  });

  it('wraps no key to a connection granted only the cards', async () => {
    const { backend, service } = harness([connectionTo(user, ['cards'])]);
    await seed(service, 'Dairy', ['Milk']);
    expect(Object.keys(backend.slices.get(agent.uuid)![0]!.envelope.keys)).toEqual([agent.uuid]);
  });

  it('checks off the user’s item under the user’s own item id', async () => {
    // An observation is a second opinion about an existing element: it has to collide
    // with their row in the union-by-id rather than fork a second row beside it.
    const { backend, service } = harness([connectionTo(user)]);
    publishSliceAs(backend, crypto, user, snapshot([section('s')], [item('milk', 's')]), [
      user,
      agent,
    ]);
    await service.apply((ctx) => setChecked(ctx, 'milk', true));

    expect(publishedSlice(backend).items.map((i) => i.id)).toEqual(['milk']);
    const view = await service.view();
    const items = view.list.sections[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.item.checkedOffDate).not.toBeNull();
    expect(items[0]!.provenance.kind).toBe('own');
  });

  it('re-seals above the server’s version when a write comes back stale', async () => {
    const { backend, service } = harness();
    // The server already holds ver 4 from a run this peer has forgotten.
    publishSliceAs(backend, crypto, agent, snapshot([], []), [agent], 4);
    await service.apply((ctx) => ({ slice: ctx.own, value: null }));
    expect(backend.slices.get(agent.uuid)![0]!.ver).toBe(5);
  });

  it('refuses to build a write on a slice of ours that does not verify', async () => {
    // The failure that must never degrade: an empty slice published over an unreadable
    // one drops every item this agent holds, with a success reported to the model.
    const { backend, service } = harness();
    const forged = crypto.seal(
      'shoppinglist',
      `${agent.uuid}::${agent.uuid}`,
      2,
      Buffer.from('{}', 'utf8'),
      [{ uuid: agent.uuid, x25519PublicKey: agent.encPublicKey }],
      agent.uuid,
      user.signingKeyPair.secretKey,
    );
    backend.slices.set(agent.uuid, [{ authorUuid: agent.uuid, ver: 2, envelope: forged }]);
    backend.slicePuts = 0;
    await expect(service.view()).rejects.toThrow(ShoppingStoreError);
    expect(backend.slicePuts).toBe(0);
  });

  it('serializes concurrent writes rather than losing one to the other', async () => {
    // Both are legitimately ours, so the server's version check cannot catch a lost
    // update — only the queue can.
    const { backend, service } = harness();
    const sectionId = await seed(service, 'Dairy', ['seed']);
    await Promise.all([
      service.apply((ctx) => addItems(ctx, sectionId, [{ name: 'Milk' }])),
      service.apply((ctx) => addItems(ctx, sectionId, [{ name: 'Eggs' }])),
    ]);
    expect(
      publishedSlice(backend)
        .items.map((i) => i.name)
        .sort(),
    ).toEqual(['Eggs', 'Milk', 'seed']);
  });

  it('rebuilds the recipient set on republish, which is what a revoke rides on', async () => {
    const { backend, service, roster } = harness([connectionTo(user)]);
    await seed(service, 'Dairy', ['Milk']);
    roster.save({ connections: [], handledRequestIds: [] });
    await service.republish();
    expect(Object.keys(backend.slices.get(agent.uuid)![0]!.envelope.keys)).toEqual([agent.uuid]);
    // The items survive the rotation: a revoke changes who can read, not what is there.
    expect(publishedSlice(backend).items.map((i) => i.name)).toEqual(['Milk']);
  });
});

describe('the shared list end to end', () => {
  it('lets the agent add to a section the user created and nobody else holds', async () => {
    const { backend, service } = harness([connectionTo(user)]);
    publishSliceAs(backend, crypto, user, snapshot([section('s', { title: 'Dairy' })], []), [
      user,
      agent,
    ]);
    await service.apply((ctx) => addItems(ctx, 's', [{ name: 'Milk' }]));

    // The section is adopted into our slice (lc-ing) — an item cannot exist under a
    // section row its writer does not hold.
    expect(publishedSlice(backend).sections.map((s) => s.id)).toEqual(['s']);
    const view = await service.view();
    expect(activeItems(view.list.sections[0]!).map((i) => i.item.name)).toEqual(['Milk']);
  });
});

/**
 * Create a section and add `names` to it in one write — what `add_items` does when it is
 * given a title nobody holds, and what most of these tests need before they have a list
 * to talk about.
 */
async function seed(
  service: ShoppingService,
  title: string,
  names: readonly string[],
): Promise<string> {
  const { value } = await service.apply((ctx) => {
    const created = createSection(ctx, title);
    const base = {
      ...ctx,
      own: created.slice,
      merged: {
        ...ctx.merged,
        sections: [...ctx.merged.sections, { section: created.value, items: [] }],
      },
    };
    const added = addItems(
      base,
      created.value.id,
      names.map((name) => ({ name })),
    );
    return { slice: added.slice, value: created.value.id };
  });
  return value;
}
