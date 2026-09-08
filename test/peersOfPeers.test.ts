import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CardService } from '../src/cards/cardService.js';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { ConnectionManager, decodeShareDoc } from '../src/sharing/connections.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { withIndirectPeers, type Connection, type Roster } from '../src/sharing/roster.js';
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
 * Peers of peers (lcm-8lm) — the fix for an agent that seals only to the account that
 * connected it.
 *
 * The defect these tests pin is not a crash. Two people share a space, one of them
 * connects the agent, and every resource the agent publishes is wrapped to that one
 * account: the other person sees no agent and none of its writes, and no key exists
 * anywhere that would open the ciphertext for them. So the load-bearing assertion in
 * this file is the last one in "the whole point" — a card the agent added, opening for
 * a user who never accepted anything.
 *
 * Everything else here guards the ways that could be made to work badly: a peer's
 * document is only believed when it verifies against the key **we** pinned, a peer can
 * never re-pin an account we already hold, and an indirect entry is granted exactly
 * what the connection that vouched for it is granted and never the default of
 * everything.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
/** This agent. */
let agent: Identity;
/** The user who runs the connect flow — the agent's one direct connection. */
let vid: Identity;
/** The second seat: connected to Vid, and to this agent through nobody. */
let ana: Identity;
/** A third account, for the one-hop rule. */
let mo: Identity;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  agent = identityOf(sodium, 21);
  vid = identityOf(sodium, 22);
  ana = identityOf(sodium, 23);
  mo = identityOf(sodium, 24);
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
      displayName: 'Vid',
      kind: 'person',
    },
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-peers-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  const state = new SyncStateStore(dir);
  const cards = new CardService(agent, backend, crypto, state, roster, {
    now: () => 1_800_000_000_000,
    newId: () => 'card-1',
  });
  const manager = new ConnectionManager(
    agent,
    backend,
    crypto,
    state,
    roster,
    () => cards.republish(),
    { now: () => 1_800_000_000_000 },
  );
  return { backend, roster, manager, cards };
}

/** Connect `vid` to the agent the way the operator would: accept their request. */
async function connectVid(h: ReturnType<typeof harness>): Promise<void> {
  h.backend.requests = [requestFrom(vid, 1)];
  await h.manager.accept(1);
}

/** Publish Vid's grant document naming `peers`, readable by this agent. */
function vidVouchesFor(
  h: ReturnType<typeof harness>,
  peers: readonly ShareDocPeer[],
  ver = 1,
): void {
  publishShareDocAs(h.backend, crypto, vid, peers, [vid, agent], ver);
}

describe('the whole point', () => {
  it('seals a card the agent wrote to a peer of a peer, who can then open it', async () => {
    const h = harness();
    // Vid accepts the agent. Ana never sees this agent at all — she is connected to
    // Vid, and Vid's grant document is the only place her keys appear.
    vidVouchesFor(h, [shareDocEntry(agent, 'Agent'), shareDocEntry(ana, 'Ana')]);
    await connectVid(h);

    expect(h.manager.connections().map((c) => c.uuid)).toContain(ana.uuid);

    await h.cards.add({ title: 'Bakery' });
    const envelope = h.backend.cards.get(agent.uuid)!.envelope;

    // The assertion the bead is about: a key wrapped to Ana, and plaintext behind it.
    expect(envelope.keys[ana.uuid]).toBeDefined();
    const plaintext = crypto.decrypt(envelope, ana.uuid, ana.encryptionKeyPair);
    expect(Buffer.from(plaintext).toString('utf8')).toContain('Bakery');
  });

  it('marks an indirect entry and attributes it to the connection that vouched', async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await connectVid(h);

    const entries = h.manager.connections();
    expect(entries.find((c) => c.uuid === vid.uuid)!.learnedFrom).toBeNull();
    expect(entries.find((c) => c.uuid === ana.uuid)).toMatchObject({
      displayName: 'Ana',
      learnedFrom: vid.uuid,
      kind: 'person',
    });
  });

  it('reports what a pass added, so a caller can say so', async () => {
    const h = harness();
    await connectVid(h);
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')], 2);

    const discovery = await h.manager.syncPeers();
    expect(discovery.added.map((c) => c.uuid)).toEqual([ana.uuid]);
    expect(discovery.unreadable).toEqual([]);
  });

  it('re-publishes when it learns someone, so they can read without a further write', async () => {
    const h = harness();
    await connectVid(h);
    await h.cards.add({ title: 'Bakery' });
    expect(h.backend.cards.get(agent.uuid)!.envelope.keys[ana.uuid]).toBeUndefined();

    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')], 2);
    await h.manager.syncPeers();

    expect(h.backend.cards.get(agent.uuid)!.envelope.keys[ana.uuid]).toBeDefined();
  });
});

describe('the scope an indirect peer gets', () => {
  it('inherits the scopes of the connection it was learned through', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await h.manager.accept(1, { scopes: ['shopping'] });

    // Not ALL_SCOPES, which is what a roster written before scopes means and what a
    // silent default would have handed an account nobody approved.
    expect(h.manager.connections().find((c) => c.uuid === ana.uuid)!.scopes).toEqual(['shopping']);
  });

  it('ignores the scopes the vouching peer wrote — those are about their data', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    vidVouchesFor(h, [{ ...shareDocEntry(ana, 'Ana'), scopes: ['CARDS', 'SHOPPING'] }]);
    await h.manager.accept(1, { scopes: ['cards'] });

    expect(h.manager.connections().find((c) => c.uuid === ana.uuid)!.scopes).toEqual(['cards']);
  });

  it('does not wrap a cards key to a peer inherited from a shopping-only connection', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1)];
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await h.manager.accept(1, { scopes: ['shopping'] });

    await h.cards.add({ title: 'Bakery' });
    const keys = h.backend.cards.get(agent.uuid)!.envelope.keys;
    expect(keys[ana.uuid]).toBeUndefined();
    expect(keys[vid.uuid]).toBeUndefined();
  });
});

describe('what a peer is not allowed to do', () => {
  it('will not re-pin an account we already hold under different keys', async () => {
    const h = harness();
    // Vid names Ana's uuid carrying Mo's keys — a substitution, whatever it is meant as.
    vidVouchesFor(h, [{ ...shareDocEntry(ana, 'Ana'), encKey: b64(mo.encPublicKey) }]);
    await connectVid(h);
    const pinned = h.manager.connections().find((c) => c.uuid === ana.uuid)!;

    publishShareDocAs(h.backend, crypto, vid, [{ ...shareDocEntry(ana, 'Ana') }], [vid, agent], 2);
    const discovery = await h.manager.syncPeers();

    expect(discovery.added).toEqual([]);
    expect(discovery.skipped).toMatchObject([{ uuid: ana.uuid, reason: 'key_mismatch' }]);
    expect(h.manager.connections().find((c) => c.uuid === ana.uuid)!.encKey).toBe(pinned.encKey);
  });

  it('never downgrades a direct connection to an indirect one', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1), requestFrom(ana, 2)];
    await h.manager.accept(1);
    await h.manager.accept(2);
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')], 2);

    const discovery = await h.manager.syncPeers();
    expect(discovery.skipped).toMatchObject([{ uuid: ana.uuid, reason: 'already_known' }]);
    expect(h.manager.connections().find((c) => c.uuid === ana.uuid)!.learnedFrom).toBeNull();
  });

  it("still offers an indirect peer's own request for an answer", async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await connectVid(h);
    h.backend.requests = [...h.backend.requests, requestFrom(ana, 2)];

    // Nobody compared Ana's safety number and nobody chose her scopes. A peer vouching
    // for her is not the operator answering, so the request stays waiting.
    expect((await h.manager.pending()).map((r) => r.requesterUuid)).toEqual([ana.uuid]);
  });

  it('upgrades an indirect peer to one entry when they connect directly', async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await connectVid(h);

    h.backend.requests = [...h.backend.requests, requestFrom(ana, 2)];
    await h.manager.accept(2, { scopes: ['cards'] });

    const entries = h.manager.connections().filter((c) => c.uuid === ana.uuid);
    expect(entries).toHaveLength(1);
    // One row, direct, and carrying the scopes the operator chose rather than the ones
    // it inherited while it was only vouched for.
    expect(entries[0]).toMatchObject({ learnedFrom: null, scopes: ['cards'] });
  });

  it('refuses a key that is not 32 real base64 bytes, and names the entry', async () => {
    const h = harness();
    vidVouchesFor(h, [{ ...shareDocEntry(ana, 'Ana'), encKey: 'not base64 at all!' }]);
    await connectVid(h);

    const discovery = await h.manager.syncPeers();
    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
    const refused = discovery.skipped.find((s) => s.reason === 'malformed_key')!;
    expect(refused.uuid).toBe(ana.uuid);
    expect(refused.detail).toContain('encKey');
  });

  it('refuses a key of the right encoding and the wrong length', () => {
    const short = b64(new Uint8Array(16).fill(3));
    const merged = withIndirectPeers(
      emptyRoster(),
      directConnection(vid, ['cards']),
      [
        {
          uuid: ana.uuid,
          displayName: 'Ana',
          signKey: short,
          encKey: short,
          kind: 'person',
          admittedAt: 0,
        },
      ],
      agent.uuid,
      1,
    );
    expect(merged.added).toEqual([]);
    expect(merged.skipped[0]!.detail).toContain('16 bytes, expected 32');
  });

  it('skips this agent, which every grant document naming it as a recipient contains', async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(agent, 'Agent')]);
    await connectVid(h);

    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
  });

  it('follows only direct connections, so an indirect peer cannot extend the roster', async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await connectVid(h);
    // Ana, who this agent knows only through Vid, vouches for Mo. One hop and no more.
    publishShareDocAs(h.backend, crypto, ana, [shareDocEntry(mo, 'Mo')], [ana, agent]);

    await h.manager.syncPeers();
    expect(
      h.manager
        .connections()
        .map((c) => c.uuid)
        .sort(),
    ).toEqual([ana.uuid, vid.uuid].sort());
  });
});

describe('a document this agent will not believe', () => {
  it('ignores one that does not verify against the pinned key', async () => {
    const h = harness();
    await connectVid(h);
    // Signed by Mo, stored at Vid's address — a server substituting a roster it wrote.
    publishShareDocAs(h.backend, crypto, mo, [shareDocEntry(ana, 'Ana')], [agent]);
    h.backend.shares.set(vid.uuid, h.backend.shares.get(mo.uuid)!);

    const discovery = await h.manager.syncPeers();
    expect(discovery.added).toEqual([]);
    expect(discovery.unreadable).toMatchObject([{ uuid: vid.uuid, reason: 'not_verified' }]);
    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
  });

  it('reports a document published with no key wrapped to this agent', async () => {
    const h = harness();
    await connectVid(h);
    publishShareDocAs(h.backend, crypto, vid, [shareDocEntry(ana, 'Ana')], [vid], 2);

    const discovery = await h.manager.syncPeers();
    expect(discovery.added).toEqual([]);
    expect(discovery.unreadable).toMatchObject([{ uuid: vid.uuid, reason: 'not_granted' }]);
  });

  it('reports one that decrypts but does not parse', async () => {
    const h = harness();
    await connectVid(h);
    publishShareDocAs(h.backend, crypto, vid, 'not json', [vid, agent], 2);

    const discovery = await h.manager.syncPeers();
    expect(discovery.unreadable).toMatchObject([{ uuid: vid.uuid, reason: 'malformed' }]);
  });

  it('reports a fetch that failed rather than implying the space is empty', async () => {
    const h = harness();
    await connectVid(h);
    h.backend.unreachableShares.add(vid.uuid);

    const discovery = await h.manager.syncPeers();
    expect(discovery.unreadable).toMatchObject([{ uuid: vid.uuid, reason: 'unreachable' }]);
    expect(h.manager.connections().map((c) => c.uuid)).toEqual([vid.uuid]);
  });

  it('carries on past one unreadable connection to read the next', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1), requestFrom(mo, 2)];
    await h.manager.accept(1);
    await h.manager.accept(2);
    h.backend.unreachableShares.add(vid.uuid);
    publishShareDocAs(h.backend, crypto, mo, [shareDocEntry(ana, 'Ana')], [mo, agent]);

    const discovery = await h.manager.syncPeers();
    expect(discovery.added.map((c) => c.uuid)).toEqual([ana.uuid]);
    expect(discovery.unreadable).toHaveLength(1);
  });
});

describe('a forged envelope from an indirect peer', () => {
  it('is still rejected, because the key pinned for them came from the grant doc', async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await connectVid(h);

    // A card blob at Ana's address, claiming to be hers and signed by Mo — the
    // substitution an unverified indirect entry would open the door to. It is checked
    // against the key Vid's grant document carried, which is the only key this agent
    // ever pinned for Ana, so the forgery has nothing to verify against.
    const forged = crypto.sign(
      'cards',
      ana.uuid,
      1,
      crypto.encrypt(Buffer.from(JSON.stringify({ cards: [] }), 'utf8'), [
        { uuid: agent.uuid, x25519PublicKey: agent.encPublicKey },
      ]),
      ana.uuid,
      mo.signingKeyPair.secretKey,
    );
    h.backend.cards.set(ana.uuid, { envelope: forged, ver: 1 });

    const view = await h.cards.view();
    expect(view.unreadable).toContainEqual(
      expect.objectContaining({
        uuid: ana.uuid,
        reason: 'not_verified',
        detail: expect.stringContaining('pinned'),
      }),
    );
  });
});

/**
 * The cascade — an indirect peer's claim on this agent's keys is the connection that
 * vouched for it, and nothing else.
 *
 * These used to be reached through `revoke`, which is gone (lcm-9m7): this agent has no
 * verb that removes another account. The two ways a connection can now leave are the
 * household evicting it and this agent walking out, and both have to take the subtree
 * with them for the same reason revoke did.
 */
describe('losing the connection an indirect peer arrived through', () => {
  it('takes the indirect peer with it rather than leaving an orphan', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1), requestFrom(mo, 2)];
    await h.manager.accept(1);
    await h.manager.accept(2);
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')], 2);
    await h.manager.syncPeers();
    expect(h.manager.connections()).toHaveLength(3);

    // Mo declares Vid out of the household. Ana was only ever in this roster because
    // Vid vouched for her.
    publishShareDocAs(h.backend, crypto, mo, [], [mo, agent], 2, [evictionBy(mo, vid)]);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).toEqual([mo.uuid]);
  });

  it('stops sealing to the orphan on the very next publish', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1), requestFrom(mo, 2)];
    await h.manager.accept(1);
    await h.manager.accept(2);
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')], 2);
    await h.manager.syncPeers();
    await h.cards.add({ title: 'Bakery' });
    expect(h.backend.cards.get(agent.uuid)!.envelope.keys[ana.uuid]).toBeDefined();

    publishShareDocAs(h.backend, crypto, mo, [], [mo, agent], 2, [evictionBy(mo, vid)]);
    await h.manager.syncPeers();

    expect(h.backend.cards.get(agent.uuid)!.envelope.keys[ana.uuid]).toBeUndefined();
  });

  it('leaves a peer that is also vouched for by a connection that stays', async () => {
    const h = harness();
    h.backend.requests = [requestFrom(vid, 1), requestFrom(mo, 2)];
    await h.manager.accept(1);
    await h.manager.accept(2);
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')], 2);
    publishShareDocAs(h.backend, crypto, mo, [shareDocEntry(ana, 'Ana')], [mo, agent]);
    await h.manager.syncPeers();

    // Attributed to whichever vouched first. Evicting *that* one drops her with it, and
    // the same pass re-derives her through the connection that still names her — which
    // is the right answer: she was never only that one's peer, and the eviction was not
    // about her.
    const via = h.manager.connections().find((c) => c.uuid === ana.uuid)!.learnedFrom!;
    const stays = via === vid.uuid ? mo : vid;
    publishShareDocAs(h.backend, crypto, stays, [shareDocEntry(ana, 'Ana')], [stays, agent], 3, [
      { uuid: via, atMillis: 1_800_000_000_001, by: stays.uuid },
    ]);
    await h.manager.syncPeers();

    expect(h.manager.connections().map((c) => c.uuid)).not.toContain(via);
    expect(h.manager.connections().find((c) => c.uuid === ana.uuid)!.learnedFrom).toBe(stays.uuid);
  });

  it('takes everything with it when the agent walks out', async () => {
    const h = harness();
    vidVouchesFor(h, [shareDocEntry(ana, 'Ana')]);
    await connectVid(h);
    expect(h.manager.connections()).toHaveLength(2);

    const result = await h.manager.leave();

    expect(result.left.map((c) => c.uuid).sort()).toEqual([vid.uuid, ana.uuid].sort());
    expect(h.manager.connections()).toEqual([]);
  });

  it('drops an orphan the roster file somehow already holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-peers-'));
    dirs.push(dir);
    const orphan = { ...directConnection(ana, ['cards']), learnedFrom: 'gone' };
    new RosterStore(dir).save({
      connections: [directConnection(vid, ['cards']), orphan],
      handledRequestIds: [],
      evictions: [],
    });
    expect(new RosterStore(dir).load().connections.map((c) => c.uuid)).toEqual([vid.uuid]);
  });
});

describe('decodeShareDoc', () => {
  it('reads the uppercase tokens the app writes', () => {
    const peers = decodeShareDoc(
      JSON.stringify({
        connections: [
          { uuid: 'u', displayName: 'Ana', signKey: 'a', encKey: 'b', scopes: ['CARDS'] },
          { uuid: 'v', signKey: 'c', encKey: 'd', kind: 'AGENT' },
        ],
      }),
    );
    expect(peers.peers).toEqual([
      { uuid: 'u', displayName: 'Ana', signKey: 'a', encKey: 'b', kind: 'person', admittedAt: 0 },
      { uuid: 'v', displayName: null, signKey: 'c', encKey: 'd', kind: 'agent', admittedAt: 0 },
    ]);
  });

  it('keeps an entry whose keys are missing, so it can be refused by name', () => {
    const peers = decodeShareDoc(JSON.stringify({ connections: [{ uuid: 'u' }] }));
    expect(peers.peers).toEqual([
      { uuid: 'u', displayName: null, signKey: '', encKey: '', kind: 'person', admittedAt: 0 },
    ]);
  });

  it('drops an entry with no uuid, which there is no way to report', () => {
    expect(decodeShareDoc(JSON.stringify({ connections: [{ signKey: 'a' }] })).peers).toEqual([]);
  });

  it('throws for a document that is not a connections array', () => {
    expect(() => decodeShareDoc('[]')).toThrow(/JSON object/);
    expect(() => decodeShareDoc('{}')).toThrow(/connections/);
  });
});

function emptyRoster(): Roster {
  return { connections: [], handledRequestIds: [], evictions: [] };
}

function directConnection(identity: Identity, scopes: Connection['scopes']): Connection {
  return {
    uuid: identity.uuid,
    displayName: null,
    signKey: b64(identity.signPublicKey),
    encKey: b64(identity.encPublicKey),
    scopes,
    kind: 'person',
    connectedAt: 1_800_000_000_000,
    admittedAt: 1_800_000_000_000,
    learnedFrom: null,
  };
}
