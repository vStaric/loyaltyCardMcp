import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { shoppingTools } from '../src/mcp/shoppingTools.js';
import type { ToolDefinition } from '../src/mcp/tool.js';
import { ToolInputError } from '../src/mcp/tool.js';
import type { Connection, ResourceScope } from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { ShoppingService } from '../src/shopping/shoppingService.js';
import { decodeShoppingSnapshotBytes } from '../src/shopping/snapshot.js';
import { ShoppingWriteError } from '../src/shopping/writer.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import { FakeBackend, identityOf, publishSliceAs } from './support/fakeBackend.js';
import { item, section, snapshot } from './shoppingFixtures.js';

/**
 * The shopping tool surface: what a model is handed, and what it is told when it asks
 * for something that is not there.
 *
 * Two properties carry the weight. **Ids are always reported**, because every write
 * takes one and a model that has to guess will guess wrong. And **an empty answer says
 * why it is empty** (§7.3): "your list is empty" and "you did not give me your list" are
 * different sentences, and only one of them is this agent's to make.
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

function connectionTo(
  identity: Identity,
  scopes: readonly ResourceScope[] = ['shopping'],
): Connection {
  return {
    uuid: identity.uuid,
    displayName: 'Vid',
    signKey: Buffer.from(identity.signPublicKey).toString('base64'),
    encKey: Buffer.from(identity.encPublicKey).toString('base64'),
    scopes,
    kind: 'person',
    connectedAt: 0,
  };
}

interface Harness {
  readonly backend: FakeBackend;
  readonly tools: readonly ToolDefinition[];
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly ownSlice: () => ReturnType<typeof decodeShoppingSnapshotBytes>;
}

function harness(connections: readonly Connection[] = []): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-shoptools-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  if (connections.length > 0) roster.save({ connections, handledRequestIds: [] });
  let seq = 0;
  const service = new ShoppingService(agent, backend, crypto, new SyncStateStore(dir), roster, {
    now: () => 1_800_000_000_000,
    newId: () => `new-${++seq}`,
  });
  const tools = shoppingTools(service);
  return {
    backend,
    tools,
    call: async (name, args = {}) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return (await tool.run(args)) as Record<string, unknown>;
    },
    ownSlice: () => {
      const envelope = backend.slices.get(agent.uuid)?.[0]?.envelope;
      if (!envelope) throw new Error('nothing published');
      return decodeShoppingSnapshotBytes(
        crypto.decrypt(envelope, agent.uuid, agent.encryptionKeyPair),
      );
    },
  };
}

interface RenderedSection {
  id: string;
  title: string;
  items: { index: number; id: string; name: string; checkedOff: boolean; writtenBy: string }[];
}

function sectionsOf(result: Record<string, unknown>): RenderedSection[] {
  return result.sections as RenderedSection[];
}

describe('the surface', () => {
  it('exposes the eight writes and the read, and no way to remove a section', () => {
    // Deliberate: a section's tombstone only takes effect once it is empty on every
    // slice, so the honest removal from here is to tombstone its items.
    expect(harness().tools.map((t) => t.name)).toEqual([
      'list_shopping',
      'add_items',
      'rename_item',
      'set_checked',
      'set_footnote',
      'move_item',
      'create_section',
      'rename_section',
      'remove_item',
    ]);
  });

  it('marks only the read tool read-only, and only the removal destructive', () => {
    const { tools } = harness();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(readOnly).toEqual(['list_shopping']);
    expect(destructive).toEqual(['remove_item']);
  });
});

describe('list_shopping', () => {
  it('reports every row with its id, its index and who wrote it', async () => {
    const { backend, call } = harness([connectionTo(user)]);
    publishSliceAs(
      backend,
      crypto,
      user,
      snapshot(
        [section('s', { title: 'Dairy' })],
        [item('milk', 's', { footnote: 'the blue one' })],
      ),
      [user, agent],
    );
    const sections = sectionsOf(await call('list_shopping'));
    expect(sections[0]).toMatchObject({ id: 's', title: 'Dairy' });
    expect(sections[0]!.items[0]).toMatchObject({
      index: 0,
      id: 'milk',
      name: 'milk',
      checkedOff: false,
      footnote: 'the blue one',
      writtenBy: 'Vid',
    });
  });

  it('can leave the checked-off rows out', async () => {
    const { backend, call } = harness([connectionTo(user)]);
    publishSliceAs(
      backend,
      crypto,
      user,
      snapshot(
        [section('s')],
        [
          item('milk', 's', { checkedOffDate: 1, stateChangedAt: 1 }),
          item('eggs', 's', { sortOrder: 1 }),
        ],
      ),
      [user, agent],
    );
    const sections = sectionsOf(await call('list_shopping', { includeChecked: false }));
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['eggs']);
  });

  it('says nobody has accepted this agent rather than showing an empty list', async () => {
    const result = await harness().call('list_shopping');
    expect(result.message).toContain('no connections yet');
  });

  it('names the connection that withheld the shopping list', async () => {
    const { backend, call } = harness([connectionTo(user, ['cards'])]);
    publishSliceAs(backend, crypto, user, snapshot([section('s')], [item('milk', 's')]), [user]);
    const result = await call('list_shopping');
    expect(result.message).toContain('has not granted this agent the shopping list');
    expect(result.unreadable).toMatchObject([{ account: 'Vid', reason: 'not_granted' }]);
  });
});

describe('writes', () => {
  it('adds to a section named by title, case-insensitively', async () => {
    const { backend, call, ownSlice } = harness([connectionTo(user)]);
    publishSliceAs(backend, crypto, user, snapshot([section('s', { title: 'Dairy' })], []), [
      user,
      agent,
    ]);
    const result = await call('add_items', { section: 'dairy', names: ['Milk', 'Eggs'] });
    expect(result.section).toMatchObject({ id: 's', title: 'Dairy', created: false });
    expect(result.added).toEqual([
      { id: 'new-1', name: 'Milk' },
      { id: 'new-2', name: 'Eggs' },
    ]);
    expect(ownSlice().items.map((i) => i.name)).toEqual(['Milk', 'Eggs']);
  });

  it('creates the section when the title names none', async () => {
    const { call, ownSlice } = harness();
    const result = await call('add_items', { section: 'Hardware', names: ['Nails'] });
    expect(result.section).toMatchObject({ title: 'Hardware', created: true });
    expect(ownSlice().sections.map((s) => s.title)).toEqual(['Hardware']);
    expect(ownSlice().items).toHaveLength(1);
  });

  it('accepts a single name where a list belongs', async () => {
    const { call, ownSlice } = harness();
    await call('add_items', { section: 'Dairy', names: 'Milk' });
    expect(ownSlice().items).toHaveLength(1);
  });

  it('reports blank names as skipped rather than pretending they were added', async () => {
    const { call } = harness();
    const result = await call('add_items', { section: 'Dairy', names: ['Milk', '  '] });
    expect(result).toMatchObject({ skippedBlankNames: 1 });
    expect(result.added).toHaveLength(1);
  });

  it('checks off an item and says which one', async () => {
    const { backend, call } = harness([connectionTo(user)]);
    publishSliceAs(backend, crypto, user, snapshot([section('s')], [item('milk', 's')]), [
      user,
      agent,
    ]);
    const result = await call('set_checked', { itemId: 'milk', checked: true });
    expect(result.checkedOff).toMatchObject({ id: 'milk', checkedOff: true });
  });

  it('tombstones on remove rather than dropping the row', async () => {
    const { call, ownSlice } = harness();
    const added = (await call('add_items', { section: 'Dairy', names: ['Milk'] })).added as {
      id: string;
    }[];
    const result = await call('remove_item', { itemId: added[0]!.id });
    expect(result.removed).toMatchObject({ id: added[0]!.id, removed: true });
    expect(ownSlice().items).toHaveLength(1);
    expect(ownSlice().items[0]!.clearedDate).not.toBeNull();
  });

  it('refuses an unknown item id by name, without publishing anything', async () => {
    const { backend, call } = harness();
    await expect(call('set_checked', { itemId: 'ghost', checked: true })).rejects.toThrow(
      ShoppingWriteError,
    );
    expect(backend.slicePuts).toBe(0);
  });

  it('refuses an argument of the wrong type by naming the argument', async () => {
    const { call } = harness();
    await expect(call('set_checked', { itemId: 'x', checked: 'yes' })).rejects.toThrow(
      ToolInputError,
    );
  });

  it('refuses to rename a section nobody holds', async () => {
    const { call } = harness();
    await expect(call('rename_section', { section: 'Nope', title: 'x' })).rejects.toThrow(
      ShoppingWriteError,
    );
  });

  it('moves an item and reports where the list now stands', async () => {
    const { call } = harness();
    await call('add_items', { section: 'Dairy', names: ['Milk', 'Eggs', 'Butter'] });
    await call('move_item', { itemId: 'new-4', toIndex: 0 });
    const sections = sectionsOf(await call('list_shopping'));
    expect(sections[0]!.items.map((i) => i.name)).toEqual(['Butter', 'Milk', 'Eggs']);
  });

  it('nests an item without disturbing the rest', async () => {
    const { call } = harness();
    await call('add_items', { section: 'Dairy', names: ['Milk', 'Eggs'] });
    await call('move_item', { itemId: 'new-3', indentLevel: 1 });
    const sections = sectionsOf(await call('list_shopping'));
    expect(sections[0]!.items.map((i) => i.name)).toEqual(['Milk', 'Eggs']);
    expect(sections[0]!.items[1]).toMatchObject({ indentLevel: 1 });
  });

  it('footnotes an item, and drops the sub-footnote when the note is unpinned', async () => {
    const { call, ownSlice } = harness();
    await call('add_items', { section: 'Dairy', names: ['Milk'] });
    await call('set_footnote', { itemId: 'new-2', text: 'blue top', footnoteSub: 'not green' });
    expect(ownSlice().items[0]).toMatchObject({ footnote: 'blue top', footnoteSub: 'not green' });
    await call('set_footnote', { itemId: 'new-2', text: null });
    expect(ownSlice().items[0]).toMatchObject({ footnote: null, footnoteSub: null });
  });
});
