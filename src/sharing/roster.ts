import type { Recipient } from '../crypto/envelopeCrypto.js';
import type { ConnectionKind } from './connectInvite.js';

/**
 * Who this peer shares with, and on what terms — port of `sync/sharing/Roster.kt`.
 *
 * The roster holds only **public** material (uuids, names, public keys), so it lives
 * in the config directory as plain JSON next to the identity rather than under any
 * additional protection. It is nonetheless the trust anchor: the keys in it are
 * **pinned on first contact** and never silently replaced, so a later server-side key
 * swap cannot redirect our wrapped content keys to somebody else.
 */

/**
 * One of the two resources a connection can be granted, independently of the other
 * (lc-chp, PRD-agent-connection §4.3).
 *
 * ## Two directions, and only one of them lives here
 * A scope on *our* roster entry is what **we** seal to that peer. What the peer seals
 * to *us* is their decision, recorded on their device, and this file cannot see it —
 * we learn it only by whether their envelope carries a content key wrapped to us. So
 * a card read that comes back ungranted is not a state this roster can predict, and
 * the card layer must report the refusal it actually met rather than guess from here.
 *
 * The honest limit is per resource, not per field: a scope names a whole resource
 * because a whole resource is what one content key seals. Granting `cards` grants the
 * barcode values.
 */
export type ResourceScope = 'cards' | 'shopping';

export const RESOURCE_SCOPES: readonly ResourceScope[] = ['cards', 'shopping'];

/** Both resources — the default grant, and what a roster written before scopes holds. */
export const ALL_SCOPES: readonly ResourceScope[] = RESOURCE_SCOPES;

/** The scope `wire` names, or `null` for anything this version does not recognise. */
export function resourceScopeFromWire(wire: string | null | undefined): ResourceScope | null {
  return RESOURCE_SCOPES.find((s) => s === wire) ?? null;
}

/**
 * One connected account: a peer this agent seals its resources to, subject to
 * {@link scopes}.
 *
 * Keys are standard-padded base64 — the same encoding the wire and the envelope crypto
 * use — so an entry round-trips straight to a {@link Recipient} without re-deriving
 * anything.
 */
export interface Connection {
  readonly uuid: string;
  readonly displayName: string | null;
  /** Pinned Ed25519 signing key (base64) — verifies this peer's envelopes. */
  readonly signKey: string;
  /** Pinned X25519 encryption key (base64) — wraps our content keys to them. */
  readonly encKey: string;
  /** What we seal to them. An empty list is legal: connected, sharing nothing. */
  readonly scopes: readonly ResourceScope[];
  /**
   * Person or agent, as the **operator** confirmed it — never as the peer asserted it
   * ({@link ConnectionKind}). Nothing verifies the claim and nothing enforces the
   * label: it changes how a write is drawn, never what a peer may read (that is
   * {@link scopes}).
   */
  readonly kind: ConnectionKind;
  /** Epoch millis this connection was pinned — shown by `tolar-mcp connections`. */
  readonly connectedAt: number;
  /**
   * Where this entry came from: `null` for a **direct** connection — one the operator
   * accepted by hand, after comparing a safety number — or the uuid of the direct
   * connection whose grant document named it, for an **indirect** one (lcm-8lm).
   *
   * Indirect entries exist because the sharing topology the user has in mind is a
   * *space*, not a set of pairs. Two people connect this agent; without this field the
   * agent seals every write to the one account that ran the connect flow, and the other
   * person sees nothing and cannot even tell the agent is there. Merging peers-of-peers
   * out of a verified grant doc is what makes the second seat work.
   *
   * It is also the thing an operator has to be able to *see*, because an indirect peer
   * is an account they did not personally approve. `tolar-mcp connections` marks these
   * and names the connection they arrived through; nothing here is silent.
   */
  readonly learnedFrom: string | null;
}

/** The persisted sharing state: who we share with, and which requests we answered. */
export interface Roster {
  readonly connections: readonly Connection[];
  /**
   * Inbound `requestShare` ids already actioned. The backend has no dismiss endpoint,
   * so a declined — or already-accepted — request is suppressed locally rather than
   * removed server-side, keeping the inbox from re-surfacing it forever.
   */
  readonly handledRequestIds: readonly number[];
}

export const EMPTY_ROSTER: Roster = { connections: [], handledRequestIds: [] };

/** True when `connection` is granted `scope` — the one question the wrap layer asks. */
export function grants(connection: Connection, scope: ResourceScope): boolean {
  return connection.scopes.includes(scope);
}

/**
 * True when this entry was learned from another connection's grant document rather
 * than approved by the operator (see {@link Connection.learnedFrom}).
 */
export function isIndirect(connection: Connection): boolean {
  return connection.learnedFrom !== null;
}

/** This connection as an envelope recipient (decodes the pinned encryption key). */
export function toRecipient(connection: Connection): Recipient {
  return { uuid: connection.uuid, x25519PublicKey: decodeKey(connection.encKey) };
}

/** The pinned signing key as raw bytes, for verifying this peer's envelopes. */
export function signingKeyOf(connection: Connection): Uint8Array {
  return decodeKey(connection.signKey);
}

/** Add or replace `connection` (matched by uuid), keeping connections uuid-unique. */
export function withConnection(roster: Roster, connection: Connection): Roster {
  return {
    ...roster,
    connections: [...roster.connections.filter((c) => c.uuid !== connection.uuid), connection],
  };
}

/**
 * Drop the connection with `uuid`, if present (revoke) — **and everything learned
 * through it**.
 *
 * The cascade is not tidiness. An indirect peer is in this roster because a direct
 * connection vouched for it; revoke that connection and the vouching is withdrawn, so
 * leaving the peer behind would have the agent go on sealing its cards to an account
 * whose only claim to them was a grant the operator just tore up — an orphan nobody
 * approved and nobody can now explain. Revoking is the one operation whose whole
 * purpose is "stop sharing with them", and it has to mean the whole subtree.
 *
 * A peer that is *also* reachable through some other connection still is: the next
 * discovery pass re-adds it, attributed to that one. That is the correct answer — it
 * was never only A's peer — and it arrives by the same visible route as any other
 * indirect entry rather than by surviving a revoke silently.
 */
export function withoutConnection(roster: Roster, uuid: string): Roster {
  return {
    ...roster,
    connections: roster.connections.filter((c) => c.uuid !== uuid && c.learnedFrom !== uuid),
  };
}

/** Mark inbound request `id` as actioned so the inbox stops offering it. */
export function withHandledRequest(roster: Roster, id: number): Roster {
  if (roster.handledRequestIds.includes(id)) return roster;
  return { ...roster, handledRequestIds: [...roster.handledRequestIds, id] };
}

/** The connection with `uuid`, or `null`. */
export function connectionOf(roster: Roster, uuid: string): Connection | null {
  return roster.connections.find((c) => c.uuid === uuid) ?? null;
}

/**
 * Base64 that must decode to real key bytes.
 *
 * Node's decoder skips characters it does not recognise rather than failing, so a
 * corrupted roster would otherwise yield a short key and a wrapped CEK nobody can
 * open — a silent loss of sharing. Failing here names the entry instead.
 */
function decodeKey(b64: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== b64) {
    throw new Error(`roster holds a malformed base64 key: ${b64}`);
  }
  return bytes;
}

// --- peers of peers (lcm-8lm) ---------------------------------------------------

/** Ed25519 and X25519 public keys are both 32 bytes. Nothing else is a key. */
export const PUBLIC_KEY_BYTES = 32;

/**
 * One account named in a connection's grant document, exactly as that document spelt
 * it — a *claim relayed by a peer*, not yet anything this roster has agreed to.
 *
 * The keys are still base64 strings here on purpose: whether they are usable keys is
 * one of the things {@link withIndirectPeers} decides, and it has to be able to name
 * the entry it is refusing.
 */
export interface IndirectPeer {
  readonly uuid: string;
  readonly displayName: string | null;
  readonly signKey: string;
  readonly encKey: string;
  /** What the vouching peer labelled them. A relayed claim; see {@link Connection.kind}. */
  readonly kind: ConnectionKind;
}

/** Why one peer named in a grant document did not become a connection. */
export type IndirectSkipReason =
  /** That uuid is this agent itself. */
  | 'self'
  /** Already in the roster under the same keys — the first pin stands. */
  | 'already_known'
  /** Already in the roster under **different** keys. Never silently re-pinned. */
  | 'key_mismatch'
  /** `signKey` or `encKey` is not 32 bytes of real base64. */
  | 'malformed_key';

/** One refused peer, with enough to say which entry and why. */
export interface SkippedPeer {
  readonly uuid: string;
  readonly displayName: string | null;
  /** The direct connection whose grant document named them. */
  readonly learnedFrom: string;
  readonly reason: IndirectSkipReason;
  /** Long form, for an operator who has to act on it. */
  readonly detail: string;
}

/** What one grant document's peer list did to the roster. */
export interface IndirectMerge {
  readonly roster: Roster;
  readonly added: readonly Connection[];
  readonly skipped: readonly SkippedPeer[];
}

/**
 * Merge the peers named in `learnedFrom`'s grant document into `roster` as indirect
 * connections — the whole of the policy, in one pure function so the decisions it
 * makes are testable without a network.
 *
 * ## The scope question, answered
 * `ResourceScope` is per connection and an indirect peer arrives with no scope the
 * operator chose. It **inherits the scopes of the connection it was learned through**.
 *
 * The alternative — defaulting to {@link ALL_SCOPES} because that is what a pre-scopes
 * roster means — is the one answer that must not be taken: granting `cards` grants the
 * barcode values, and an account nobody approved would get them because of a
 * backwards-compatibility default. Inheritance is defensible instead because it is the
 * only reading with a person behind it: the operator decided what this agent shares
 * with A, A vouched for B, so B gets what A gets and never more. Narrow A's grant and
 * everything learned through A narrows with it on the next pass.
 *
 * ## What is refused, and loudly
 * A uuid already in the roster keeps its **first** pin. If the grant document carries
 * different keys for it, that is a `key_mismatch` and nothing is written — a rotation
 * this agent cannot distinguish from a substitution is a substitution, and here the
 * substitution would be performed by a peer rather than by the server. Keys that are
 * not 32 real base64 bytes are `malformed_key`, named rather than repaired: a short key
 * would wrap a content key nobody can open, which is a silent loss of sharing.
 */
export function withIndirectPeers(
  roster: Roster,
  learnedFrom: Connection,
  peers: readonly IndirectPeer[],
  selfUuid: string,
  now: number,
): IndirectMerge {
  const added: Connection[] = [];
  const skipped: SkippedPeer[] = [];
  let next = roster;
  for (const peer of peers) {
    const skip = (reason: IndirectSkipReason, detail: string): void => {
      skipped.push({
        uuid: peer.uuid,
        displayName: peer.displayName,
        learnedFrom: learnedFrom.uuid,
        reason,
        detail,
      });
    };
    if (peer.uuid === selfUuid) {
      skip('self', 'that entry is this agent — every grant document names its recipients');
      continue;
    }
    const existing = next.connections.find((c) => c.uuid === peer.uuid);
    if (existing) {
      if (existing.signKey !== peer.signKey || existing.encKey !== peer.encKey) {
        skip(
          'key_mismatch',
          `${learnedFrom.uuid} names ${peer.uuid} under different keys than the ones pinned ` +
            'here — refusing to re-pin. Revoke the existing connection first if this really ' +
            'is the same account with new keys.',
        );
      } else {
        skip(
          'already_known',
          existing.learnedFrom === null
            ? 'already a direct connection, which outranks anything a peer can say'
            : `already learned from ${existing.learnedFrom}`,
        );
      }
      continue;
    }
    const badKey = firstBadKey(peer);
    if (badKey) {
      skip('malformed_key', badKey);
      continue;
    }
    const connection: Connection = {
      uuid: peer.uuid,
      displayName: peer.displayName,
      signKey: peer.signKey,
      encKey: peer.encKey,
      // Inherited, never widened — see this function's doc comment.
      scopes: learnedFrom.scopes,
      kind: peer.kind,
      connectedAt: now,
      learnedFrom: learnedFrom.uuid,
    };
    next = withConnection(next, connection);
    added.push(connection);
  }
  return { roster: next, added, skipped };
}

/**
 * Every indirect entry whose vouching connection is missing from `connections`, removed.
 *
 * {@link withoutConnection} keeps that invariant on the revoke path, but the roster is
 * a file: a hand edit, a partial write, or a roster written by some future version can
 * still present an orphan — an account this agent would seal to with nothing left to
 * explain why. One pass suffices, because indirect entries are only ever learned from
 * **direct** connections, so orphaning does not chain.
 */
export function withoutOrphans(connections: readonly Connection[]): readonly Connection[] {
  const present = new Set(connections.filter((c) => c.learnedFrom === null).map((c) => c.uuid));
  return connections.filter((c) => c.learnedFrom === null || present.has(c.learnedFrom));
}

/** The first unusable key on `peer`, described, or `null` when both are fine. */
function firstBadKey(peer: IndirectPeer): string | null {
  for (const [name, value] of [
    ['signKey', peer.signKey],
    ['encKey', peer.encKey],
  ] as const) {
    const problem = keyProblem(value);
    if (problem) return `${peer.uuid} has an unusable ${name}: ${problem}`;
  }
  return null;
}

/**
 * Why `b64` is not a public key, or `null` if it is one.
 *
 * Stricter than {@link decodeKey} by a length check, and deliberately so: that one
 * guards a file this agent wrote itself, where a wrong length means corruption, while
 * this one guards bytes a *peer* chose. Base64 alone would accept `""` — which decodes
 * to nothing, re-encodes to `""`, and would be pinned as a key that wraps to nobody.
 */
function keyProblem(b64: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeKey(b64);
  } catch {
    return `not base64 (${JSON.stringify(b64)})`;
  }
  if (bytes.length !== PUBLIC_KEY_BYTES) {
    return `${bytes.length} bytes, expected ${PUBLIC_KEY_BYTES}`;
  }
  return null;
}
