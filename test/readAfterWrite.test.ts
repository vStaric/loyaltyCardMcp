import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from '../src/crypto/envelope.js';
import { CardPhotoService } from '../src/cards/cardPhotos.js';
import { CardService } from '../src/cards/cardService.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { cardTools } from '../src/mcp/cardTools.js';
import { createServer } from '../src/mcp/server.js';
import { shoppingTools } from '../src/mcp/shoppingTools.js';
import type { ToolDefinition } from '../src/mcp/tool.js';
import type { Connection } from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { ShoppingService } from '../src/shopping/shoppingService.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import { FakeBackend, identityOf } from './support/fakeBackend.js';

/**
 * Read-after-write within one MCP session (lcm-8wb).
 *
 * ## The bug this file exists to keep dead
 * MCP tool calls do not arrive one at a time. A model that adds items and then reads the
 * list back — the natural way to confirm and report — has both calls dispatched
 * together, and every read here is a fresh GET of the server, because this peer keeps no
 * local mirror. Nothing made the GET wait for the PUT, so the read answered with the
 * account as it stood *before* the write it was issued after.
 *
 * ## Why it is filed higher than an ordinary ordering bug
 * The answer that came back was `{"sections": []}` — no refusal, no unreadable source,
 * nothing to distinguish it from an account with nothing on the list. `mcp/server.ts`
 * tells the model that an empty result which is really a refusal must never be reported
 * as "your list is empty"; that instruction is defenceless against an empty result that
 * is *genuinely* empty and *false*. So the agent said "your list is empty" moments after
 * five items were accepted — the one sentence the whole empty-vs-refusal design exists
 * to prevent.
 *
 * The fix is that reads share the write queue, so these cases assert an ordering, not a
 * cache: what the tools report after a write is what the write left behind.
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

/**
 * A backend whose writes land a turn of the event loop later than its reads.
 *
 * The real one behaves this way for real reasons — a PUT is bigger than a GET and the
 * server does more with it — but a race that only sometimes loses is a test that only
 * sometimes fails. Delaying the PUT makes the losing interleaving the *certain* one, so
 * a read that overtakes its own write fails here every time rather than on CI's bad days.
 */
class SlowWrites extends FakeBackend {
  override async putShoppingSlice(
    listId: string,
    authorUuid: string,
    envelope: Envelope,
  ): Promise<number> {
    await nextTurn();
    return super.putShoppingSlice(listId, authorUuid, envelope);
  }

  override async putCards(uuid: string, envelope: Envelope): Promise<number> {
    await nextTurn();
    return super.putCards(uuid, envelope);
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const connection = (): Connection => ({
  uuid: user.uuid,
  displayName: 'Vid',
  signKey: Buffer.from(user.signPublicKey).toString('base64'),
  encKey: Buffer.from(user.encPublicKey).toString('base64'),
  scopes: ['cards', 'shopping'],
  kind: 'person',
  connectedAt: 0,
});

/** The whole tool surface over one slow backend, as a session would hold it. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-raw-'));
  dirs.push(dir);
  const backend = new SlowWrites();
  const roster = new RosterStore(dir);
  roster.save({ connections: [connection()], handledRequestIds: [] });
  const state = new SyncStateStore(dir);
  let seq = 0;
  const cards = new CardService(agent, backend, crypto, state, roster, {
    now: () => 1_800_000_000_000,
    newId: () => `agent-card-${++seq}`,
  });
  const shopping = new ShoppingService(agent, backend, crypto, state, roster, {
    now: () => 1_800_000_000_000,
    newId: () => `new-${++seq}`,
  });
  const tools: readonly ToolDefinition[] = [
    ...cardTools(cards, new CardPhotoService(cards, backend)),
    ...shoppingTools(shopping),
  ];
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args) as Promise<Record<string, unknown>>;
  };
  return { backend, tools, run };
}

interface RenderedSection {
  id: string;
  title: string;
  items: { id: string; name: string }[];
}

describe('a read issued after a write in the same session', () => {
  it('sees the items the write just added, not the list as it was', async () => {
    const { run } = harness();
    // Dispatched together and never awaited in between — what a host does with two tool
    // calls a model emitted in one turn.
    const writing = run('add_items', { section: 'Dairy', names: ['milk', 'butter', 'cheese'] });
    const listing = run('list_shopping');
    const [, list] = await Promise.all([writing, listing]);

    const sections = list.sections as RenderedSection[];
    expect(sections.map((s) => s.title)).toEqual(['Dairy']);
    expect(sections[0]!.items.map((i) => i.name)).toEqual(['milk', 'butter', 'cheese']);
    // The sentence this bead is really about: an empty list must not be manufactured.
    expect(list.message).toBeUndefined();
  });

  it('never reports a list as empty while the write that filled it is in flight', async () => {
    const { run } = harness();
    const writing = run('create_section', { title: 'Bakery' });
    const listing = run('list_shopping');
    await Promise.all([writing, listing]);
    const list = await listing;

    // "The shared shopping list is empty." is a true sentence about an empty account and
    // a lie about this one. It is the exact string the server's instructions forbid the
    // model to pass on, so it must never be produced here in the first place.
    expect(list.message).toBeUndefined();
    expect((list.sections as RenderedSection[]).map((s) => s.title)).toEqual(['Bakery']);
  });

  it('lists a card the add in flight beside it has already been told landed', async () => {
    const { run } = harness();
    const adding = run('add_card', {
      title: 'Mercator Pika',
      barcodeValue: '590',
      barcodeFormat: 'EAN_13',
    });
    const listing = run('list_cards');
    const [added, list] = await Promise.all([adding, listing]);

    const cards = list.cards as { id: string; title: string }[];
    const id = (added.added as { id: string }).id;
    expect(cards.map((c) => c.id)).toContain(id);
    expect(list.message).toBeUndefined();
  });

  it('shows an edit the update in flight beside it reported, not the title it replaced', async () => {
    const { run } = harness();
    const added = await run('add_card', { title: 'Mercator Pika' });
    const id = (added.added as { id: string }).id;

    const updating = run('update_card', { cardId: id, title: 'Mercator Pika Kartica' });
    const reading = run('get_card', { cardId: id });
    const [, got] = await Promise.all([updating, reading]);

    expect((got.card as { title: string }).title).toBe('Mercator Pika Kartica');
  });

  it('drops a card the delete in flight beside it reported gone', async () => {
    const { run } = harness();
    const added = await run('add_card', { title: 'Mercator Pika' });
    const id = (added.added as { id: string }).id;

    const deleting = run('delete_card', { cardId: id });
    const listing = run('list_cards');
    const [, list] = await Promise.all([deleting, listing]);

    expect((list.cards as { id: string }[]).map((c) => c.id)).not.toContain(id);
  });

  it('keeps writes ordered among themselves, and a read after them sees them all', async () => {
    const { run, backend } = harness();
    // Four writes and a read, all in flight at once — the shape of the session that
    // found this: create_section ×2, add_items ×2, then list_shopping.
    const calls = [
      run('create_section', { title: 'Bakery' }),
      run('create_section', { title: 'Store cupboard' }),
      run('add_items', { section: 'Bakery', names: ['croissants', 'rye bread'] }),
      run('add_items', { section: 'Store cupboard', names: ['coffee beans', 'olive oil'] }),
    ];
    const listing = run('list_shopping');
    await Promise.all(calls);
    const list = await listing;

    const sections = list.sections as RenderedSection[];
    expect(sections.map((s) => s.title)).toEqual(['Bakery', 'Store cupboard']);
    expect(sections.flatMap((s) => s.items.map((i) => i.name))).toEqual([
      'croissants',
      'rye bread',
      'coffee beans',
      'olive oil',
    ]);
    // Each write published once: serializing reads must not have cost a republish.
    expect(backend.slicePuts).toBe(4);
  });
});

describe('the same, over a real session', () => {
  /**
   * The protocol edge, because that is where the defect was found. Driving the tool
   * functions directly proves the services queue; only a client issuing two `tools/call`
   * requests without waiting proves the queue survives the dispatch the SDK gives them —
   * two requests, two handlers, both already running.
   */
  it('answers list_shopping with what add_items wrote, when both are in flight', async () => {
    const { tools } = harness();
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createServer(tools).connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const writing = client.callTool({
      name: 'add_items',
      arguments: { section: 'Dairy', names: ['milk'] },
    });
    const listing = client.callTool({ name: 'list_shopping', arguments: {} });
    const [write, list] = await Promise.all([writing, listing]);

    expect(write.isError).toBeFalsy();
    expect(list.isError).toBeFalsy();
    const text = (list.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('milk');
    expect(text).not.toContain('The shared shopping list is empty.');
  });
});
