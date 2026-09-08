import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CardService } from '../src/cards/cardService.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { ConnectionManager, decodeShareDoc, encodeShareDoc } from '../src/sharing/connections.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import type { ShareRequestViewDto } from '../src/sync/wire.js';
import {
  evictionBy,
  FakeBackend,
  identityOf,
  publishShareDocAs,
  shareDocEntry,
  type ShareDocPeer,
} from './support/fakeBackend.js';

/**
 * Eviction (lcm-9m7) — the agent half of the household model in lc-gx2w.
 *
 * Two halves, and they point in opposite directions on purpose.
 *
 * **The agent obeys.** A member of a household may declare a person or an agent out of
 * it. The record rides the grant document, which is already signed and already sealed to
 * every member, and this agent honours it: the account leaves the roster, the next
 * publish does not seal to it, and an introducer whose own document still lists the
 * evicted account cannot bring it back.
 *
 * **The agent cannot issue one.** `revoke <uuid>` used to let it remove any account in
 * its roster and cascade through everything learned from that account, which is the
 * eviction power the spec denies it. That verb is gone rather than renamed, and the only
 * removal left is {@link ConnectionManager.leave} — the agent walking out itself, which
 * needs nobody's permission.
 *
 * What this is **not** is enforcement. `Connection.kind` is operator-asserted and
 * unverified, so nothing here binds a modified agent or a hostile reimplementation of
 * the protocol. What it buys is that the shipping agent does not have the capability,
 * which does not depend on anybody else's opinion of what this uuid is.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
/** This agent. */
let agent: Identity;
/** The member who connected the agent. */
let vid: Identity;
/** A second seat, learned from Vid's grant document. */
let ana: Identity;
/** A third member, who does the evicting in most of these. */
let mo: Identity;
const dirs: string[] = [];

/** The moment every accept in this file happens, so evictions can be dated around it. */
const ADMITTED = 1_800_000_000_000;

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  agent = identityOf(sodium, 31);
  vid = identityOf(sodium, 32);
  ana = identityOf(sodium, 33);
  mo = identityOf(sodium, 34);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function requestFrom(identity: Identity, id: number): ShareRequestViewDto {
  return {
    id,
    createdAt: '2026-09-08T06:00:00Z',
    responded: false,
    requester: {
      requesterUuid: identity.uuid,
      requesterSignKey: b64(identity.signPublicKey),
      requesterEncKey: b64(identity.encPublicKey),
      displayName: 'Someone',
      kind: 'person',
    },
  };
}

function harness(
  dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-evict-')),
  backend = new FakeBackend(),
) {
  dirs.push(dir);
  const roster = new RosterStore(dir);
  const state = new SyncStateStore(dir);
  const clock = { now: ADMITTED };
  const cards = new CardService(agent, backend, crypto, state, roster, {
    now: () => clock.now,
    newId: () => 'card-1',
  });
  const manager = new ConnectionManager(
    agent,
    backend,
    crypto,
    state,
    roster,
    () => cards.republish(),
    { now: () => clock.now },
  );
  return { backend, roster, manager, cards, clock, dir };
}

type Harness = ReturnType<typeof harness>;

/** Publish `author`'s grant document, readable by this agent. */
function publishes(
  h: Harness,
  author: Identity,
  peers: readonly ShareDocPeer[],
  ver = 1,
  evictions: readonly { uuid: string; atMillis?: number; by?: string }[] = [],
): void {
  publishShareDocAs(h.backend, crypto, author, peers, [author, agent], ver, evictions);
}

/** Vid connects the agent and vouches for Ana: the roster this file starts from. */
async function household(h: Harness): Promise<void> {
  h.backend.requests = [requestFrom(vid, 1), requestFrom(mo, 2)];
  await h.manager.accept(1);
  await h.manager.accept(2);
  publishes(h, vid, [shareDocEntry(ana, 'Ana')], 2);
  await h.manager.syncPeers();
}

describe('honouring an eviction a member published', () => {
  it('drops the account and stops sealing to it on the very next publish', async () => {
    const h = harness();
    await household(h);
    await h.cards.add({ title: 'Bakery' });
    expect(h.backend.cards.get(agent.uuid)!.envelope.keys[ana.uuid]).toBeDefined();

    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);
    expect(h.backend.cards.get(agent.uuid)!.envelope.keys[ana.uuid]).toBeUndefined();
  });

  it('is not undone by an introducer whose document still names her', async () => {
    // The failure lc-gx2w is about: membership is derived, so a local removal is
    // recomputed away on the next pass unless the eviction outranks the derivation.
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();

    // Vid re-publishes, still listing Ana, exactly as an introducer that has not caught
    // up would. Three more passes, in case the answer depends on fetch order.
    publishes(h, vid, [shareDocEntry(ana, 'Ana')], 3);
    await h.manager.syncPeers();
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);
  });

  it('holds when the eviction and the entry that contradicts it are in one document', async () => {
    // Subtract *last* rather than in document order: Vid lists Ana and evicts her in the
    // same breath, which is what a member's own document looks like the moment before
    // their roster catches up with their decision.
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    await h.manager.accept(1);
    publishes(h, vid, [shareDocEntry(ana, 'Ana')], 2, [evictionBy(vid, ana)]);

    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
  });

  it('names what it obeyed, so an account does not just vanish from the list', async () => {
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);

    const discovery = await h.manager.syncPeers();

    expect(discovery.evicted).toEqual([
      { uuid: ana.uuid, at: ADMITTED + 1, by: mo.uuid, learnedFrom: mo.uuid },
    ]);
  });

  it('announces it once, not on every pass that re-reads the document', async () => {
    // The document keeps carrying the record forever. A pass that re-obeyed it would
    // re-publish and re-announce an eviction that happened once, days ago.
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();
    const ver = h.backend.shares.get(agent.uuid)!.ver;

    const second = await h.manager.syncPeers();

    expect(second.evicted).toEqual([]);
    expect(h.backend.shares.get(agent.uuid)!.ver).toBe(ver);
  });

  it('keeps honouring it when the member who published it goes unreachable', async () => {
    // The reason the tombstone is persisted rather than recomputed each pass: forgetting
    // an eviction the first time the network is down would resurrect the account.
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();

    h.backend.unreachableShares.add(mo.uuid);
    publishes(h, vid, [shareDocEntry(ana, 'Ana')], 3);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);
  });

  it('survives a restart, and says why the peer is refused', async () => {
    const first = harness();
    await household(first);
    publishes(first, mo, [], 2, [evictionBy(mo, ana)]);
    await first.manager.syncPeers();

    // A fresh process over the same config directory — the roster file is the only thing
    // that carries the answer across.
    const restarted = harness(first.dir, first.backend);
    publishes(restarted, vid, [shareDocEntry(ana, 'Ana')], 4);
    const discovery = await restarted.manager.syncPeers();

    expect(restarted.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);
    expect(discovery.skipped.find((s) => s.uuid === ana.uuid)).toMatchObject({
      reason: 'evicted',
    });
  });

  it('takes an evicted direct connection out too — it is not a peers-only rule', async () => {
    const h = harness();
    await household(h);

    publishes(h, mo, [], 2, [evictionBy(mo, vid)]);
    await h.manager.syncPeers();

    // Vid was accepted here by the operator, and is still removed: a household evicting a
    // member is a decision about the household, not about how this agent met them.
    expect(h.manager.connections().map((c) => c.uuid)).toEqual([mo.uuid]);
  });

  it('reads an undated eviction as now rather than ignoring it', async () => {
    // The two ways of being wrong are not symmetric. Honouring an eviction that should
    // not have applied costs one re-accept; ignoring a real one leaves the agent sealing
    // to an account the household removed.
    const h = harness();
    await household(h);

    publishes(h, mo, [], 2, [{ uuid: ana.uuid, by: mo.uuid }]);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);
  });
});

describe('an eviction naming this agent', () => {
  it('takes the agent out of that household rather than leaving it looking connected', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    await h.manager.accept(1);
    publishes(h, vid, [shareDocEntry(ana, 'Ana')], 2);
    await h.manager.syncPeers();
    expect(h.manager.connections()).toHaveLength(2);

    publishes(h, vid, [], 3, [evictionBy(vid, agent)]);
    await h.manager.syncPeers();

    // The connection that told us goes, and everything learned through it goes with it.
    expect(h.manager.connections()).toEqual([]);
    expect(h.manager.evictedSelf()).toMatchObject({ uuid: agent.uuid, learnedFrom: vid.uuid });
  });

  it('stops publishing to that household', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    await h.manager.accept(1);
    await h.cards.add({ title: 'Bakery' });
    const before = h.backend.shares.get(agent.uuid)!.ver;

    publishes(h, vid, [], 2, [evictionBy(vid, agent)]);
    await h.manager.syncPeers();

    // No further grant document is written to a household this agent is no longer in, and
    // the cards it re-seals afterwards carry no key for anyone there.
    expect(h.backend.shares.get(agent.uuid)!.ver).toBe(before);
    expect(Object.keys(h.backend.cards.get(agent.uuid)!.envelope.keys)).toEqual([agent.uuid]);
  });

  it('is not honoured when the household invited the agent back afterwards', async () => {
    const h = harness();
    // The eviction is older than the accept: their request is what invited this agent in
    // again, and a re-invitation outranks an eviction that predates it.
    h.backend.requests = [requestFrom(vid, 1)];
    h.clock.now = ADMITTED + 10;
    await h.manager.accept(1);
    publishes(h, vid, [], 2, [evictionBy(vid, agent, ADMITTED + 5)]);

    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
  });
});

describe('coming back after an eviction', () => {
  it('lets the operator accept an evicted account here, which outranks the record', async () => {
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();
    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);

    // Ana asks in her own right, and the operator says yes — after the eviction, on this
    // host's clock. That is the one admission this agent can date from a clock it owns.
    h.clock.now = ADMITTED + 100;
    h.backend.requests = [...h.backend.requests, requestFrom(ana, 3)];
    await h.manager.accept(3);

    expect(h.manager.connections().map((c) => c.uuid)).toContain(ana.uuid);
    // And the tombstone goes with it. Left behind it would have `connections` print her
    // as declared out while she sits in the roster above — two records of one present.
    expect(h.manager.evictions()).toEqual([]);
  });

  it('stops saying the agent was shown the door once that household lets it back in', async () => {
    // The record is not deleted — the household's document goes on carrying it, and it
    // would be re-read on the next pass anyway. It stops being *in force*, which is what
    // the banner is about: an agent that is connected must never be told it is out.
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    await h.manager.accept(1);
    publishes(h, vid, [], 2, [evictionBy(vid, agent)]);
    await h.manager.syncPeers();
    expect(h.manager.evictedSelf()).not.toBeNull();

    h.clock.now = ADMITTED + 100;
    await h.manager.accept(1);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
    expect(h.manager.evictedSelf()).toBeNull();
  });

  it('lets an introducer date an admission later than the eviction', async () => {
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();

    publishes(h, vid, [{ ...shareDocEntry(ana, 'Ana'), admittedAtMillis: ADMITTED + 50 }], 3);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).toContain(ana.uuid);
  });

  it('does not let an undated re-derivation outrank the eviction', async () => {
    // Silence has to lose here: an entry nobody dated is one this agent cannot show
    // outranks anything, and the alternative is that every sync pass quietly undoes
    // every eviction.
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();

    publishes(h, vid, [shareDocEntry(ana, 'Ana')], 3);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(ana.uuid);
  });
});

describe('the agent issues none of its own', () => {
  it('republishes no eviction it honoured', async () => {
    // Deliberately not the flooding half of lc-gx2w. A reader verifies the *document's*
    // signature — ours — and cannot check the `by` field inside it, so a relayed eviction
    // and an authored one are the same bytes downstream. Relaying would hand the agent
    // the capability back three lines after it was removed.
    const h = harness();
    await household(h);
    publishes(h, mo, [], 2, [evictionBy(mo, ana)]);
    await h.manager.syncPeers();

    const doc = readOwnShareDoc(h);
    expect(doc.evictions).toBeUndefined();
    expect(h.manager.evictions()).toHaveLength(1);
  });

  it('has no verb that removes another account', () => {
    // The surface *is* the assertion (lcm-9m7): "do not silently keep revoke working
    // under another name". A method added here has to be considered against that.
    const surface = Object.getOwnPropertyNames(ConnectionManager.prototype).sort();
    expect(surface).toEqual([
      'accept',
      'connections',
      'constructor',
      'decline',
      'discoverPeers',
      'evictedSelf',
      'evictions',
      'leave',
      'pending',
      'publishDeparture',
      'publishShareDoc',
      'readGrantDoc',
      'syncPeers',
      'tellRequester',
    ]);
  });

  it('says it is out, and only about itself, when it leaves', async () => {
    const h = harness();
    await household(h);

    await h.manager.leave();

    const doc = readOwnShareDoc(h);
    expect(doc.connections).toEqual([]);
    expect(doc.evictions).toEqual([{ uuid: agent.uuid, atMillis: ADMITTED, by: agent.uuid }]);
  });
});

describe('the grant document contract', () => {
  it('dates the accounts this host admitted, and not the ones it was told about', () => {
    const doc = JSON.parse(
      encodeShareDoc([
        {
          uuid: 'direct',
          displayName: null,
          signKey: 's',
          encKey: 'e',
          kind: 'person',
          connectedAt: ADMITTED,
          admittedAt: ADMITTED,
          learnedFrom: null,
        },
        {
          uuid: 'relayed',
          displayName: null,
          signKey: 's',
          encKey: 'e',
          kind: 'person',
          connectedAt: ADMITTED,
          admittedAt: 7,
          learnedFrom: 'direct',
        },
      ]),
    );
    expect(doc.connections[0].admittedAtMillis).toBe(ADMITTED);
    // Relayed: only the account that admitted them can date that, and this agent did not.
    expect(doc.connections[1].admittedAtMillis).toBeUndefined();
  });

  it('omits the evictions field entirely when there are none', () => {
    // So an ordinary document stays byte-identical to the one this agent always wrote.
    expect(JSON.parse(encodeShareDoc([])).evictions).toBeUndefined();
  });

  it('reads the evictions a document carries, and what it leaves out', () => {
    const doc = decodeShareDoc(
      JSON.stringify({
        connections: [],
        evictions: [
          { uuid: 'out', atMillis: 5, by: 'mo' },
          { uuid: 'undated' },
          { uuid: '' },
          'nonsense',
        ],
      }),
    );
    expect(doc.evictions).toEqual([
      { uuid: 'out', at: 5, by: 'mo' },
      { uuid: 'undated', at: null, by: null },
    ]);
  });

  it('reads a malformed evictions field as no evictions, keeping the peer list', () => {
    // It is the newer half of the contract; a peer that spells it wrongly must not cost
    // this agent the half it spelt correctly.
    const doc = decodeShareDoc(
      JSON.stringify({ connections: [{ uuid: 'u', signKey: 'a', encKey: 'b' }], evictions: 3 }),
    );
    expect(doc.evictions).toEqual([]);
    expect(doc.peers.map((p) => p.uuid)).toEqual(['u']);
  });
});

/** This agent's own published grant document, as a member of the household reads it. */
function readOwnShareDoc(h: Harness): {
  connections: unknown[];
  evictions?: unknown[];
} {
  const envelope = h.backend.shares.get(agent.uuid)!.envelope;
  return JSON.parse(
    Buffer.from(crypto.decrypt(envelope, vid.uuid, vid.encryptionKeyPair)).toString('utf8'),
  );
}
