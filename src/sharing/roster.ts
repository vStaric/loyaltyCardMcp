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
   * When the admission this entry rests on happened, in the clock of whoever made it —
   * this host's for a direct connection, the introducer's for an indirect one, and `0`
   * when nobody said (lcm-9m7).
   *
   * It exists for exactly one question: does an eviction outrank this entry, or does
   * this entry outrank the eviction? A household may kick a member out and may invite
   * them back, so the two records have to be orderable, and the only honest order is
   * by time. `0` means unknown and loses to every eviction — the safe direction, since
   * the cost of honouring an eviction wrongly is one re-accept and the cost of ignoring
   * a real one is an account the household removed still being sealed to.
   *
   * The clock is not this agent's to correct. See {@link evicts}.
   */
  readonly admittedAt: number;
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

/**
 * One account a household member declared out (lcm-9m7) — the record this agent
 * **obeys** and never writes about anyone but itself.
 *
 * Membership in a household is derived: it is recomputed from the grant documents of
 * direct connections on every pass, so a peer removed locally is re-derived by the
 * next one from an introducer that still lists them. An eviction is the record that
 * outranks that re-derivation. It travels on the grant document, which is already
 * signed and already sealed to every member, so it needs no new resource and no new
 * endpoint (lc-gx2w).
 */
export interface Eviction {
  /** The account declared out of the household. May be this agent's own uuid. */
  readonly uuid: string;
  /**
   * Epoch millis, in **the authoring device's clock** — what makes an eviction and a
   * later re-invitation orderable ({@link evicts}). Never corrected here.
   */
  readonly at: number;
  /** The account the record names as its author. A claim; see {@link learnedFrom}. */
  readonly by: string;
  /**
   * The direct connection whose signed grant document carried this record — the only
   * part of its provenance this agent verified, since the envelope's signature is over
   * the whole document rather than over {@link by}.
   */
  readonly learnedFrom: string;
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
  /**
   * Evictions this agent has read and is honouring — the tombstones (lcm-9m7).
   *
   * They are persisted rather than recomputed each pass because the document that
   * carried one may be unreachable on the next: an eviction that is forgotten the first
   * time the network is down would resurrect the account it removed, which is the
   * failure the record exists to prevent. They do not expire; see {@link evicts} for
   * the only thing that lifts one.
   */
  readonly evictions: readonly Eviction[];
}

export const EMPTY_ROSTER: Roster = { connections: [], handledRequestIds: [], evictions: [] };

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
 * Drop the connection with `uuid`, if present — **and everything learned through it**.
 *
 * The cascade is not tidiness. An indirect peer is in this roster because a direct
 * connection vouched for it; remove that connection and the vouching is withdrawn, so
 * leaving the peer behind would have the agent go on sealing its cards to an account
 * whose only claim to them was a grant that no longer exists — an orphan nobody
 * approved and nobody can now explain.
 *
 * ## Who is allowed to reach this
 * Nothing on the agent's own initiative removes another member. This is reached when
 * **this agent leaves** ({@link import('./connections.js').ConnectionManager.leave}),
 * and when a household evicts this agent through `uuid`'s document — both of which are
 * the agent walking out of a door, never a member being pushed through one. The old
 * `revoke`, which let the agent remove any account it liked and take that account's
 * whole subtree with it, is gone (lcm-9m7).
 *
 * A peer that is *also* reachable through some other connection still is: the next
 * discovery pass re-adds it, attributed to that one. That is the correct answer — it
 * was never only A's peer — and it arrives by the same visible route as any other
 * indirect entry rather than by surviving silently.
 */
export function withoutConnection(roster: Roster, uuid: string): Roster {
  return {
    ...roster,
    connections: roster.connections.filter((c) => c.uuid !== uuid && c.learnedFrom !== uuid),
  };
}

/**
 * True when `eviction` removes `connection` — the whole of the ordering rule.
 *
 * A household may kick a member out and may invite them back, so an eviction cannot be
 * permanent and cannot be conditional on nothing. It is conditional on **time**: the
 * eviction stands unless the admission the entry rests on is later than it.
 *
 * ## What that means for each kind of entry
 * For a **direct** connection, {@link Connection.admittedAt} is this host's clock at the
 * moment its operator accepted the request. So an operator who accepts an account after
 * a household evicted it has overruled the eviction on this host, deliberately, and the
 * entry stands. That is the re-invite path, and it is the only one that does not depend
 * on anybody else's clock.
 *
 * For an **indirect** one it is the `admittedAtMillis` the introducer published for that
 * account, or `0` when they published none — and `0` is later than nothing, so such an
 * entry always loses. Silence must lose here: an entry nobody dated is an entry this
 * agent cannot show outranks an eviction, and the cost of being wrong in the other
 * direction is sealing to an account the household removed.
 *
 * ## Clock skew, stated rather than hidden
 * `at` comes from the evicting device and `admittedAt` usually from another one. Whoever
 * is ahead wins. Nothing here corrects for that, and nothing could: there is no shared
 * clock and no authority to appeal to. It is named in the README for the same reason.
 */
export function evicts(eviction: Eviction, connection: Connection): boolean {
  return eviction.uuid === connection.uuid && connection.admittedAt <= eviction.at;
}

/**
 * Every connection an eviction removes, removed — the **subtract-last** rule (lc-gx2w).
 *
 * It is a filter over the finished roster rather than a check at merge time because
 * membership is derived: an eviction read from B's document must still remove a peer
 * that A's document re-derived earlier in the same pass. Applied last, once, the order
 * the documents happened to be fetched in stops mattering.
 *
 * It is also applied on the way in from disk ({@link import('./rosterStore.js')}), so
 * "we do not seal to an evicted account" is a property of every loaded roster rather
 * than of every code path that ever edits one.
 */
export function withoutEvicted(
  connections: readonly Connection[],
  evictions: readonly Eviction[],
): readonly Connection[] {
  if (evictions.length === 0) return connections;
  return connections.filter((c) => !evictions.some((e) => evicts(e, c)));
}

/**
 * Record `eviction` and apply it: the tombstone joins the roster and anything it
 * removes leaves, including a whole subtree if the evicted account was the connection
 * others were learned through.
 *
 * A second eviction of the same uuid **replaces** the one held when it is later. Two
 * members evicting the same account is ordinary — the removal floods — and keeping the
 * later time is what stops an older tombstone from being overruled by a re-invitation
 * that predates the second eviction.
 */
export function withEviction(roster: Roster, eviction: Eviction): Roster {
  const held = roster.evictions.find((e) => e.uuid === eviction.uuid);
  const evictions =
    held === undefined
      ? [...roster.evictions, eviction]
      : held.at >= eviction.at
        ? roster.evictions
        : roster.evictions.map((e) => (e.uuid === eviction.uuid ? eviction : e));
  const removed = roster.connections.filter((c) => evicts(eviction, c));
  let next: Roster = { ...roster, evictions };
  for (const c of removed) next = withoutConnection(next, c.uuid);
  return next;
}

/** The eviction held for `uuid`, or `null` — including one naming this agent itself. */
export function evictionOf(roster: Roster, uuid: string): Eviction | null {
  return roster.evictions.find((e) => e.uuid === uuid) ?? null;
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
  /**
   * When the vouching peer says **it** admitted this account, or `0` when its document
   * carried no date for the entry (lcm-9m7). Only the introducer can date its own
   * admission, so this travels only on the entries a publisher admitted directly; a
   * relayed entry arrives undated, which is the honest answer.
   */
  readonly admittedAt: number;
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
  | 'malformed_key'
  /** A household evicted them, and nothing dates their admission later than that. */
  | 'evicted';

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
            'here — refusing to re-pin. A key change has to arrive as a request this ' +
            'agent’s operator accepts, not as a line in somebody else’s document.',
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
    // The same test {@link evicts} makes, on an entry that does not exist yet.
    const eviction = next.evictions.find((e) => e.uuid === peer.uuid && peer.admittedAt <= e.at);
    if (eviction) {
      // Named rather than merged-then-subtracted, so the operator sees why a peer the
      // introducer still lists is not in the roster. The subtraction happens anyway at
      // the end of the pass ({@link withoutEvicted}) for the evictions this pass is
      // about to read; this branch is the ones already held.
      skip(
        'evicted',
        `${eviction.by} declared ${peer.uuid} out of the household, and ` +
          (peer.admittedAt === 0
            ? `${learnedFrom.uuid} publishes no date for admitting them, so nothing here ` +
              'outranks that record'
            : `${learnedFrom.uuid} dates their admission no later than it`),
      );
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
      // The introducer's date for its own admission, or 0 — never `now`, which would
      // date every re-derivation later than every eviction and quietly undo all of them.
      admittedAt: peer.admittedAt,
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
 * {@link withoutConnection} keeps that invariant wherever a connection leaves, but the
 * roster is a file: a hand edit, a partial write, or a roster written by some future version can
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
