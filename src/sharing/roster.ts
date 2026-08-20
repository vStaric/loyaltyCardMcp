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

/** Drop the connection with `uuid`, if present (revoke). */
export function withoutConnection(roster: Roster, uuid: string): Roster {
  return { ...roster, connections: roster.connections.filter((c) => c.uuid !== uuid) };
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
