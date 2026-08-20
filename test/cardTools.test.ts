import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CardService } from '../src/cards/cardService.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { cardTools } from '../src/mcp/cardTools.js';
import type { ToolDefinition } from '../src/mcp/tool.js';
import type { Connection } from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import { FakeBackend, cardOf, identityOf, publishCardsAs } from './support/fakeBackend.js';

/**
 * The tools as a model meets them.
 *
 * The service tests cover what happens; these cover what is *said*, which for this bead
 * is the deliverable. Two sentences have to survive refactoring:
 *
 * - every card states whether this agent may edit it, so a caller never has to infer it;
 * - a connection that withheld the cards scope is named in the answer, so an empty list
 *   is never reported to the user as "you have no cards".
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let agent: Identity;
let user: Identity;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  agent = identityOf(sodium, 21);
  user = identityOf(sodium, 22);
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

function harness(connections: readonly Connection[] = [connection()]) {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-tools-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  if (connections.length > 0) roster.save({ connections, handledRequestIds: [] });
  const service = new CardService(agent, backend, crypto, new SyncStateStore(dir), roster, {
    now: () => 1_800_000_000_000,
    newId: () => 'agent-card',
  });
  const tools = cardTools(service);
  const tool = (name: string): ToolDefinition => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };
  return { backend, tools, tool, service };
}

describe('the tool list', () => {
  it('offers exactly the five card tools the design names', () => {
    expect(harness().tools.map((t) => t.name)).toEqual([
      'list_cards',
      'get_card',
      'add_card',
      'update_card',
      'delete_card',
    ]);
  });

  it('tells a model, in every description, whose cards it may not touch', () => {
    for (const t of harness().tools) {
      if (t.name === 'add_card') continue;
      expect(t.description).toContain('belong to the account that created them');
    }
  });

  it('marks the reads read-only and the delete destructive', () => {
    const { tool } = harness();
    expect(tool('list_cards').annotations?.readOnlyHint).toBe(true);
    expect(tool('delete_card').annotations?.destructiveHint).toBe(true);
    expect(tool('add_card').annotations?.destructiveHint).toBe(false);
  });
});

describe('list_cards', () => {
  it('says which cards this agent may edit', async () => {
    const { backend, tool, service } = harness();
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Theirs' })], [user, agent]);
    await service.add({ title: 'Mine' });

    const result = (await tool('list_cards').run({})) as {
      cards: { title: string; addedBy: string; editableByThisAgent: boolean }[];
    };
    expect(result.cards).toEqual([
      expect.objectContaining({ title: 'Mine', addedBy: 'this agent', editableByThisAgent: true }),
      expect.objectContaining({ title: 'Theirs', addedBy: 'Vid', editableByThisAgent: false }),
    ]);
  });

  it('refuses in words when the cards scope was withheld, rather than returning nothing', async () => {
    const { backend, tool } = harness();
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Secret' })], [user]);

    const result = (await tool('list_cards').run({})) as {
      cards: unknown[];
      unreadable: { reason: string; account: string }[];
      message: string;
    };
    expect(result.cards).toEqual([]);
    expect(result.unreadable[0]).toMatchObject({ reason: 'not_granted', account: 'Vid' });
    expect(result.message).toContain('has not granted this agent the cards resource');
  });

  it('says nobody has accepted it yet when there are no connections at all', async () => {
    const result = (await harness([]).tool('list_cards').run({})) as { message: string };
    expect(result.message).toContain('no connections yet');
  });

  it('reports that a photo exists without pretending to have read it', async () => {
    const { backend, tool } = harness();
    publishCardsAs(
      backend,
      crypto,
      user,
      [
        cardOf({
          id: 'u1',
          title: 'Theirs',
          photos: {
            front: { hash: 'h', key: 'azE=' },
            back: null,
            logo: null,
            frontCleared: null,
            backCleared: null,
            logoCleared: null,
          },
        }),
      ],
      [user, agent],
    );
    const result = (await tool('list_cards').run({})) as {
      cards: { photos: { front: boolean; note?: string } }[];
    };
    expect(result.cards[0]!.photos.front).toBe(true);
    expect(result.cards[0]!.photos.note).toContain('cannot read its contents');
  });
});

describe('get_card', () => {
  it('returns the card, barcode and all', async () => {
    const { tool, service } = harness([]);
    const card = await service.add({ title: 'Cafe', barcodeValue: '123', barcodeFormat: 'EAN_13' });
    const result = (await tool('get_card').run({ cardId: card.id })) as {
      found: boolean;
      card: Record<string, unknown>;
    };
    expect(result.found).toBe(true);
    expect(result.card).toMatchObject({ barcodeValue: '123', barcodeFormat: 'EAN_13' });
  });

  it('carries the refusals with a miss, so "not found" is not read as "does not exist"', async () => {
    const { backend, tool } = harness();
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Secret' })], [user]);
    const result = (await tool('get_card').run({ cardId: 'u1' })) as {
      found: boolean;
      message: string;
      unreadable: unknown[];
    };
    expect(result.found).toBe(false);
    expect(result.unreadable).toHaveLength(1);
    expect(result.message).toContain('has not granted this agent the cards resource');
  });

  it('rejects a call with no card id', async () => {
    await expect(harness([]).tool('get_card').run({})).rejects.toThrow(/cardId is required/);
  });
});

describe('writing', () => {
  it('adds a card and says where it landed', async () => {
    const { tool } = harness([]);
    const result = (await tool('add_card').run({
      title: 'Cafe',
      barcodeValue: '123',
      barcodeFormat: 'EAN_13',
    })) as { added: Record<string, unknown>; note: string };
    expect(result.added).toMatchObject({ title: 'Cafe', editableByThisAgent: true });
    expect(result.note).toContain('attributed to this agent');
  });

  it('fails an edit of the user’s card with the reason, not a silent success', async () => {
    const { backend, tool } = harness();
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Theirs' })], [user, agent]);

    await expect(tool('update_card').run({ cardId: 'u1', title: 'Mine now' })).rejects.toThrow(
      /cards belong to the account that created them/,
    );
    expect(backend.cardPuts).toBe(0);
  });

  it('fails a delete of the user’s card the same way', async () => {
    const { backend, tool } = harness();
    publishCardsAs(backend, crypto, user, [cardOf({ id: 'u1', title: 'Theirs' })], [user, agent]);
    await expect(tool('delete_card').run({ cardId: 'u1' })).rejects.toThrow(/created by Vid/);
  });

  it('clears a field on an explicit null but refuses a null title', async () => {
    const { tool, service } = harness([]);
    const card = await service.add({ title: 'Cafe', notes: 'old' });
    const cleared = (await tool('update_card').run({ cardId: card.id, notes: null })) as {
      updated: { notes: string | null };
    };
    expect(cleared.updated.notes).toBeNull();
    await expect(tool('update_card').run({ cardId: card.id, title: null })).rejects.toThrow(
      /title is required/,
    );
  });

  it('leaves untouched fields alone rather than blanking what the caller did not mention', async () => {
    const { tool, service } = harness([]);
    const card = await service.add({ title: 'Cafe', notes: 'keep me' });
    const result = (await tool('update_card').run({ cardId: card.id, title: 'Cafe Nero' })) as {
      updated: { notes: string | null };
    };
    expect(result.updated.notes).toBe('keep me');
  });
});
