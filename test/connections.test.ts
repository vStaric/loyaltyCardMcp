import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto } from '../src/crypto/envelopeCrypto.js';
import type { Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import {
  ConnectedRequesterError,
  ConnectionKeyMismatchError,
  ConnectionManager,
  NoSuchRequestError,
  SelfConnectError,
  encodeShareDoc,
} from '../src/sharing/connections.js';
import { SHARE_RESPONSE_TYPE } from '../src/sharing/shareResponse.js';
import { RosterStore } from '../src/sharing/rosterStore.js';
import { SyncStateStore } from '../src/sync/syncState.js';
import type { ShareRequestViewDto } from '../src/sync/wire.js';
import { FakeBackend, identityOf } from './support/fakeBackend.js';

/**
 * Accepting and revoking — the only place this agent decides who it shares with.
 *
 * The grant document is the part worth being careful about: the app learns it was
 * accepted by finding its own uuid in that envelope's **recipient key map**, so an
 * accept that skips the publish leaves a working connection showing as "Invited ·
 * waiting" on the user's phone forever.
 */
let sodium: SodiumCrypto;
let crypto: EnvelopeCrypto;
let agent: Identity;
let user: Identity;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
  crypto = new EnvelopeCrypto(sodium);
  agent = identityOf(sodium, 11);
  user = identityOf(sodium, 12);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function requestFrom(
  identity: Identity,
  id: number,
  kind: string | null = 'person',
): ShareRequestViewDto {
  return {
    id,
    createdAt: '2026-08-20T06:00:00Z',
    responded: false,
    requester: {
      requesterUuid: identity.uuid,
      requesterSignKey: b64(identity.signPublicKey),
      requesterEncKey: b64(identity.encPublicKey),
      displayName: 'Vid',
      kind,
    },
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-conn-'));
  dirs.push(dir);
  const backend = new FakeBackend();
  const roster = new RosterStore(dir);
  const republished: number[] = [];
  const manager = new ConnectionManager(
    agent,
    backend,
    crypto,
    new SyncStateStore(dir),
    roster,
    async () => republished.push(1),
    { now: () => 1_800_000_000_000 },
  );
  return { backend, roster, manager, republished };
}

describe('pending requests', () => {
  it('shows a request with the safety number the operator has to compare', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1, 'agent')];
    const [pending] = await manager.pending();
    expect(pending).toMatchObject({ id: 1, requesterUuid: user.uuid, declaredKind: 'agent' });
    expect(pending!.safetyNumber).toMatch(/^[0-9a-f]{5} /);
  });

  it('hides requests already actioned, and accounts already connected', async () => {
    const { backend, roster, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    roster.save({ connections: [], handledRequestIds: [1] });
    expect(await manager.pending()).toEqual([]);
  });

  it('hides a request from ourselves', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(agent, 1)];
    expect(await manager.pending()).toEqual([]);
  });

  it('reads an unrecognised kind claim as no claim', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1, 'robot')];
    expect((await manager.pending())[0]!.declaredKind).toBe('person');
  });
});

describe('accept', () => {
  it('pins the requester and publishes a grant doc naming them as a recipient', async () => {
    const { backend, manager, republished } = harness();
    backend.requests = [requestFrom(user, 1)];

    const connection = await manager.accept(1);

    expect(connection).toMatchObject({ uuid: user.uuid, scopes: ['cards', 'shopping'] });
    // The signal the app actually reads.
    expect(Object.keys(backend.shares.get(agent.uuid)!.envelope.keys).sort()).toEqual(
      [agent.uuid, user.uuid].sort(),
    );
    expect(republished).toHaveLength(1);
  });

  it('records the scopes this agent is granting, when the operator narrows them', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    expect((await manager.accept(1, { scopes: ['shopping'] })).scopes).toEqual(['shopping']);
  });

  it('takes the operator’s label over the requester’s claim', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1, 'agent')];
    expect((await manager.accept(1, { kind: 'person' })).kind).toBe('person');
  });

  it('stops offering a request once it is actioned', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    await manager.accept(1);
    expect(await manager.pending()).toEqual([]);
  });

  it('re-accepting the same request with the same keys is a no-op, not a second peer', async () => {
    // The path an operator takes to reconnect somebody they revoked: the request is long
    // since marked handled, so naming its id is deliberate — and the pin still holds.
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    await manager.accept(1);
    await manager.revoke(user.uuid);
    await manager.accept(1);
    expect(manager.connections()).toHaveLength(1);
  });

  it('refuses an id the inbox does not hold', async () => {
    const { manager } = harness();
    await expect(manager.accept(99)).rejects.toBeInstanceOf(NoSuchRequestError);
  });

  it('refuses a request from this agent itself', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(agent, 1)];
    await expect(manager.accept(1)).rejects.toBeInstanceOf(SelfConnectError);
  });

  it('refuses a second request from a pinned uuid carrying different keys', async () => {
    const { backend, roster, manager } = harness();
    // Already connected under the real keys, but the request offers an impostor's.
    const impostor = identityOf(sodium, 13);
    roster.save({
      connections: [
        {
          uuid: user.uuid,
          displayName: 'Vid',
          signKey: b64(user.signPublicKey),
          encKey: b64(user.encPublicKey),
          scopes: ['cards'],
          kind: 'person',
          connectedAt: 0,
        },
      ],
      handledRequestIds: [],
    });
    backend.requests = [
      {
        ...requestFrom(impostor, 2),
        requester: { ...requestFrom(impostor, 2).requester, requesterUuid: user.uuid },
      },
    ];

    await expect(manager.accept(2)).rejects.toBeInstanceOf(ConnectionKeyMismatchError);
  });
});

describe('decline', () => {
  /** Open the stored decision as its only reader — what the requester's app does. */
  function decisionFor(backend: FakeBackend, id: number): { requestId: number; accepted: boolean } {
    const envelope = backend.shareResponses.get(id)!;
    expect(crypto.verify(SHARE_RESPONSE_TYPE, String(id), envelope, agent.signPublicKey)).toBe(
      true,
    );
    const plaintext = crypto.decrypt(envelope, user.uuid, user.encryptionKeyPair);
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as {
      requestId: number;
      accepted: boolean;
    };
  }

  it('stops offering the request and records the refusal for the requester', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];

    const result = await manager.decline(1);

    expect(result.notified).toBe('sent');
    expect(result.request.requesterUuid).toBe(user.uuid);
    expect(await manager.pending()).toEqual([]);
    expect(decisionFor(backend, 1)).toEqual({ requestId: 1, accepted: false });
  });

  it('shares nothing: no connection, no grant document', async () => {
    const { backend, manager, republished } = harness();
    backend.requests = [requestFrom(user, 1)];

    await manager.decline(1);

    expect(manager.connections()).toEqual([]);
    expect(backend.shares.get(agent.uuid)).toBeUndefined();
    expect(republished).toEqual([]);
  });

  it('seals the decision to the requester alone — not even this agent can read it', async () => {
    // It says nothing we need back, and the server keeps it forever; one reader is the
    // whole audience.
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    await manager.decline(1);
    expect(Object.keys(backend.shareResponses.get(1)!.keys)).toEqual([user.uuid]);
  });

  it('keeps the local dismissal when the decision cannot be recorded', async () => {
    // The half that cannot fail must not be undone by the half that can — and the
    // caller is told, because an undelivered refusal leaves them seeing silence.
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    backend.unreachableShareResponses.add(1);

    expect((await manager.decline(1)).notified).toBe('failed');
    expect(await manager.pending()).toEqual([]);
    expect(backend.shareResponses.has(1)).toBe(false);
  });

  it('does not re-answer a request it already actioned', async () => {
    // The decision table keeps the first answer; a second, freshly-sealed envelope is a
    // different one, so re-declining would earn a 409 and report a failure that says
    // nothing about what the requester can see.
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1)];
    await manager.decline(1);
    const stored = backend.shareResponses.get(1);

    expect((await manager.decline(1)).notified).toBe('skipped');
    expect(backend.shareResponses.get(1)).toBe(stored);
  });

  it('refuses to decline an account this agent already shares with', async () => {
    // Declining would tell them "no" while the grant document keeps saying yes.
    const { backend, manager } = harness();
    backend.requests = [requestFrom(user, 1), requestFrom(user, 2)];
    await manager.accept(1);

    await expect(manager.decline(2)).rejects.toBeInstanceOf(ConnectedRequesterError);
    expect(manager.connections()).toHaveLength(1);
    expect(backend.shareResponses.size).toBe(0);
  });

  it('refuses an id the inbox does not hold', async () => {
    const { manager } = harness();
    await expect(manager.decline(99)).rejects.toBeInstanceOf(NoSuchRequestError);
  });

  it('refuses a request from this agent itself', async () => {
    const { backend, manager } = harness();
    backend.requests = [requestFrom(agent, 1)];
    await expect(manager.decline(1)).rejects.toBeInstanceOf(SelfConnectError);
  });
});

describe('revoke', () => {
  it('drops the connection and re-publishes without them', async () => {
    const { backend, manager, republished } = harness();
    backend.requests = [requestFrom(user, 1)];
    await manager.accept(1);

    expect(await manager.revoke(user.uuid)).toBe(true);
    expect(manager.connections()).toEqual([]);
    // Two publishes: the accept, and the rotation after the revoke.
    expect(republished).toHaveLength(2);
  });

  it('reports a uuid it never held rather than pretending to revoke it', async () => {
    const { manager } = harness();
    expect(await manager.revoke('nobody')).toBe(false);
  });
});

describe('the grant document', () => {
  it('spells scopes and kinds the way the app’s roster deserializes them', () => {
    const doc = JSON.parse(
      encodeShareDoc([
        {
          uuid: 'u',
          displayName: 'Vid',
          signKey: 's',
          encKey: 'e',
          scopes: ['cards', 'shopping'],
          kind: 'agent',
          connectedAt: 0,
        },
      ]),
    ) as { connections: Record<string, unknown>[] };
    expect(doc.connections[0]).toMatchObject({ scopes: ['CARDS', 'SHOPPING'], kind: 'AGENT' });
  });

  it('omits a display name nobody set, the way the app’s encoder does', () => {
    const doc = JSON.parse(
      encodeShareDoc([
        {
          uuid: 'u',
          displayName: null,
          signKey: 's',
          encKey: 'e',
          scopes: [],
          kind: 'person',
          connectedAt: 0,
        },
      ]),
    ) as { connections: Record<string, unknown>[] };
    expect(doc.connections[0]).not.toHaveProperty('displayName');
  });
});
