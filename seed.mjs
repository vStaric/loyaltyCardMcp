/**
 * Seed Tolar accounts at defined content-state tiers, against the dev/staging backend.
 *
 * Tiers (product owner, 2026-08-24):
 *   loyalty cards   none / 5   / 15  / 100
 *   to-do cards     none / 3   / 10  / 50     (a "section" — the UI calls it a card)
 *   line items      --   / 5   / 25  / 150    PER to-do card
 *   connected users none / 2   / 5   / 10
 *   MCP peer        each profile is built with and without one
 *   deleted items   every non-empty set carries some
 *
 * Usage: node seed.mjs <profile>... [--api URL] [--work DIR]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openAgent, createSection, addItems, removeItem } from './dist/index.js';

const API = argOf('--api') ?? 'https://api.dev.tolar.vstaric.si';
const WORK = argOf('--work') ?? '/tmp/claude-1000/-home-dev-pale-mayor/147e8695-8fb3-4f77-84e0-2bc516039138/scratchpad/accounts';
const LEDGER = join(WORK, 'ledger.json');

/** Fraction of each set that is created and then deleted. */
const DELETED_SHARE = 0.2;

const TIERS = {
  empty: { cards: 0, todoCards: 0, itemsPer: 0, peers: 0 },
  small: { cards: 5, todoCards: 3, itemsPer: 5, peers: 2 },
  medium: { cards: 15, todoCards: 10, itemsPer: 25, peers: 5 },
  large: { cards: 100, todoCards: 50, itemsPer: 150, peers: 10 },
};

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : null;
}

function log(...parts) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${parts.join(' ')}\n`);
}

function ledger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
}

function record(name, entry) {
  const all = ledger();
  all[name] = { ...(all[name] ?? {}), ...entry };
  mkdirSync(WORK, { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(all, null, 2));
}

async function open(name, displayName) {
  const configDir = join(WORK, name);
  mkdirSync(configDir, { recursive: true });
  const agent = await openAgent({ configDir, baseUrl: API, displayName }, process.env);
  await agent.peer.ensureUserRegistered();
  return agent;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Connect `from` to `to`: request, then accept from the other side. */
async function connect(from, to, kind) {
  await from.peer.api.postRequestShare(to.peer.identity.uuid, {
    requesterUuid: from.peer.identity.uuid,
    requesterSignKey: b64(from.peer.identity.signPublicKey),
    requesterEncKey: b64(from.peer.identity.encPublicKey),
    displayName: from.peer.config.displayName,
    kind,
  });
  const pending = await to.connections.pending();
  const mine = pending.find((r) => r.requesterUuid === from.peer.identity.uuid);
  if (!mine) throw new Error(`no pending request from ${from.peer.identity.uuid}`);
  await to.connections.accept(mine.id, { scopes: ['cards', 'shopping'], kind });
  return mine.id;
}

/** Seed loyalty cards, deleting a share of them so the set carries deletions. */
async function seedCards(agent, n) {
  if (n === 0) return { live: 0, deleted: 0 };
  const made = [];
  for (let i = 1; i <= n; i++) {
    made.push(await agent.cards.add({
      title: `Card ${String(i).padStart(3, '0')}`,
      notes: i % 3 === 0 ? `note for card ${i}` : null,
      barcodeValue: `900${String(i).padStart(9, '0')}`,
      barcodeFormat: 'EAN_13',
    }));
    if (i % 25 === 0) log(`    cards ${i}/${n}`);
  }
  const toDelete = Math.floor(n * DELETED_SHARE);
  for (let i = 0; i < toDelete; i++) await agent.cards.remove(made[i].id);
  return { live: n - toDelete, deleted: toDelete };
}

/**
 * Seed to-do cards and their line items in ONE publish.
 *
 * Every writer returns a new slice and reads placement off `merged`, so the context is
 * threaded by hand: a section written but not added to `merged` is invisible to the
 * `addItems` that follows it, and the items land at slot 0 on top of each other.
 */
async function seedTodo(agent, sections, itemsPer) {
  if (sections === 0) return { sections: 0, items: 0, cleared: 0 };
  const applied = await agent.shopping.apply((ctx) => {
    let cur = ctx;
    let slice = ctx.own;
    const built = [];
    for (let s = 1; s <= sections; s++) {
      const made = createSection({ ...cur, own: slice }, `List ${String(s).padStart(3, '0')}`);
      slice = made.slice;
      cur = {
        ...cur,
        own: slice,
        merged: { ...cur.merged, sections: [...cur.merged.sections, { section: made.value, items: [] }] },
      };
      const names = Array.from({ length: itemsPer }, (_, i) => ({
        name: `Item ${String(i + 1).padStart(3, '0')}`,
      }));
      const added = addItems(cur, made.value.id, names);
      slice = added.slice;
      // Only `own` is threaded on. The merged entry deliberately keeps `items: []`:
      // nextItemSlot reads this section's slots off ctx.own for our own rows, and the
      // merged side holds MergedTodoItem wrappers rather than the raw rows addItems
      // returns — writing the raw rows in would be a shape mismatch waiting to be read.
      cur = { ...cur, own: slice };
      built.push({ id: made.value.id, items: added.value.map((i) => i.id) });
    }
    return { slice, value: built };
  });

  // A second pass tombstones a share of the items, so the set carries deletions.
  const built = applied.value;
  const doomed = built.flatMap((s) => s.items.slice(0, Math.floor(s.items.length * DELETED_SHARE)));
  if (doomed.length > 0) {
    await agent.shopping.apply((ctx) => {
      let cur = ctx;
      let slice = ctx.own;
      for (const id of doomed) {
        const res = removeItem({ ...cur, own: slice }, id);
        slice = res.slice;
        cur = { ...cur, own: slice };
      }
      return { slice, value: doomed.length };
    });
  }
  return { sections, items: sections * itemsPer, cleared: doomed.length };
}

async function seedProfile(profileName) {
  const withMcp = profileName.endsWith('+mcp');
  const tierName = withMcp ? profileName.slice(0, -4) : profileName;
  const tier = TIERS[tierName];
  if (!tier) throw new Error(`unknown profile: ${profileName}`);
  const name = profileName.replace('+', '-');

  log(`profile ${profileName}: cards=${tier.cards} todoCards=${tier.todoCards} itemsPer=${tier.itemsPer} peers=${tier.peers} mcp=${withMcp}`);
  const started = Date.now();
  const agent = await open(name, `Tolar ${profileName}`);
  const phrase = new (await import('./dist/crypto/identityStore.js')).IdentityStore(join(WORK, name)).exportMnemonic();
  record(name, { uuid: agent.peer.identity.uuid, phrase, profile: profileName, api: API });
  log(`  uuid ${agent.peer.identity.uuid}`);

  const cards = await seedCards(agent, tier.cards);
  log(`  cards: ${cards.live} live, ${cards.deleted} deleted`);

  const todo = await seedTodo(agent, tier.todoCards, tier.itemsPer);
  log(`  to-do: ${todo.sections} cards, ${todo.items} items, ${todo.cleared} cleared`);

  const peerIds = [];
  for (let p = 1; p <= tier.peers; p++) {
    const peerName = `${name}-peer-${String(p).padStart(2, '0')}`;
    const peer = await open(peerName, `Peer ${p}`);
    record(peerName, { uuid: peer.peer.identity.uuid, profile: `${profileName}:peer`, api: API });
    await connect(peer, agent, 'person');
    peerIds.push(peer.peer.identity.uuid);
    log(`  connected peer ${p}/${tier.peers}`);
  }

  let mcpUuid = null;
  if (withMcp) {
    const mcpName = `${name}-agent`;
    const mcp = await open(mcpName, 'AI agent');
    record(mcpName, { uuid: mcp.peer.identity.uuid, profile: `${profileName}:agent`, api: API });
    await connect(mcp, agent, 'agent');
    mcpUuid = mcp.peer.identity.uuid;
    log(`  connected MCP agent`);
  }

  record(name, { cards, todo, peers: peerIds, mcp: mcpUuid, seconds: Math.round((Date.now() - started) / 1000) });
  log(`  done in ${Math.round((Date.now() - started) / 1000)}s`);
}

const profiles = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.startsWith('http') && !a.startsWith('/'));
if (profiles.length === 0) {
  process.stderr.write('usage: node seed.mjs <profile>...  (empty|small|medium|large[+mcp])\n');
  process.exit(1);
}
log(`api ${API}`);
log(`work ${WORK}`);
for (const p of profiles) {
  try {
    await seedProfile(p);
  } catch (err) {
    log(`  FAILED ${p}: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    record(p.replace('+', '-'), { failed: `${err?.name ?? 'Error'}: ${err?.message ?? err}` });
  }
}
log('all done');
