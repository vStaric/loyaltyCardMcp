import type { EnvelopeCrypto } from '../crypto/envelopeCrypto.js';
import type { Identity } from '../crypto/identity.js';
import { publishResource } from '../sync/publishResource.js';
import { RESOURCE_SHARE, type SyncStateStore } from '../sync/syncState.js';
import type { TolarApi } from '../sync/tolarApi.js';
import type { ShareRequestViewDto } from '../sync/wire.js';
import { connectionKindFromWire, type ConnectionKind } from './connectInvite.js';
import { fingerprintOf, safetyNumber } from './keyFingerprint.js';
import {
  ALL_SCOPES,
  toRecipient,
  withConnection,
  withHandledRequest,
  withoutConnection,
  type Connection,
  type ResourceScope,
} from './roster.js';
import type { RosterStore } from './rosterStore.js';
import { sealShareResponse } from './shareResponse.js';

/** The envelope `resourceType` the roster grant document is signed under. */
const SHARE_TYPE = 'share';

/**
 * The connect side of being a peer: which accounts have asked this agent to share with
 * them, and which ones it does.
 *
 * ## Why accepting is an operator action and never a tool
 * `POST /api/requestShare/{uuid}` is permissionless — anyone who learns this agent's
 * uuid can queue a request against it. Accepting one wraps this agent's content keys
 * to the requester, so an agent that could accept its own connections would be one
 * prompt-injection away from sharing its cards with whoever asked. Nothing in this
 * file is exposed over MCP; it is reached through `tolar-mcp connections` / `accept` /
 * `revoke`, by the person who set the agent up. That person is also the only one who
 * can do the part that carries the trust — comparing the safety number against the one
 * the app is showing.
 */
export class ConnectionManager {
  constructor(
    private readonly identity: Identity,
    private readonly api: TolarApi,
    private readonly crypto: EnvelopeCrypto,
    private readonly state: SyncStateStore,
    private readonly roster: RosterStore,
    /**
     * Re-publish the resources this agent shares, after the roster changes. Accepting
     * re-wraps the content key to the new peer; revoking mints a fresh one and does not
     * wrap it to them (best-effort forward secrecy — what they already fetched cannot
     * be un-fetched).
     */
    private readonly onRosterChanged: () => Promise<unknown> = async () => undefined,
    private readonly deps: { readonly now?: () => number } = {},
  ) {}

  /** The accounts this agent currently shares with. */
  connections(): readonly Connection[] {
    return this.roster.load().connections;
  }

  /**
   * Inbound share requests still waiting for an answer, oldest first.
   *
   * Requests we already actioned, accounts we already share with, and any stray
   * self-request are filtered out — the port of `PendingRequestFilter.visible`.
   */
  async pending(): Promise<readonly PendingRequest[]> {
    const view = await this.api.getRequestShare(this.identity.uuid);
    const current = this.roster.load();
    return view.requests
      .filter((r) => !current.handledRequestIds.includes(r.id))
      .filter((r) => r.requester.requesterUuid !== this.identity.uuid)
      .filter((r) => !current.connections.some((c) => c.uuid === r.requester.requesterUuid))
      .map((r) => toPendingRequest(r));
  }

  /**
   * Accept request `requestId`: pin the requester's keys, start sharing with them, and
   * re-publish so their content key is wrapped in.
   *
   * The keys pinned are the ones **echoed in this request**, which reached us over a
   * signed GET of our own inbox. They are pinned once and never silently replaced: a
   * request from a uuid we already hold, carrying different keys, is refused
   * ({@link ConnectionKeyMismatchError}) rather than treated as a rotation, because a
   * rotation we cannot distinguish from a substitution is a substitution.
   *
   * This reads the **raw** inbox rather than {@link pending}. That filter decides what
   * to show an operator; this decides who gets our keys, and a display rule is the wrong
   * thing for an authorisation check to lean on — a request re-offered by a hidden path
   * must still meet the pin. It is also what makes re-accepting a peer you revoked work:
   * their request is long since marked handled, and naming its id is a deliberate act.
   *
   * `scopes` is what **this agent** shares with them, and it defaults to everything.
   * What they share with *us* is their decision, made on their accept screen; this
   * cannot set it and does not pretend to.
   */
  async accept(requestId: number, options: AcceptOptions = {}): Promise<Connection> {
    const view = await this.api.getRequestShare(this.identity.uuid);
    const raw = view.requests.find((r) => r.id === requestId);
    if (!raw) {
      throw new NoSuchRequestError(requestId);
    }
    const request = toPendingRequest(raw);
    if (request.requesterUuid === this.identity.uuid) {
      throw new SelfConnectError();
    }
    const existing = this.roster.load().connections.find((c) => c.uuid === request.requesterUuid);
    if (existing && (existing.signKey !== request.signKey || existing.encKey !== request.encKey)) {
      throw new ConnectionKeyMismatchError(request.requesterUuid);
    }
    const connection: Connection = {
      uuid: request.requesterUuid,
      displayName: request.displayName,
      signKey: request.signKey,
      encKey: request.encKey,
      scopes: options.scopes ?? ALL_SCOPES,
      kind: options.kind ?? request.declaredKind,
      connectedAt: this.deps.now?.() ?? Date.now(),
    };
    this.roster.update((r) => withHandledRequest(withConnection(r, connection), requestId));
    await this.publishShareDoc();
    await this.onRosterChanged();
    return connection;
  }

  /**
   * Decline request `requestId`: stop offering it here, and record the refusal where
   * the requester can read it.
   *
   * The backend has no delete route for a `requestShare` — the list is append-only —
   * so "dismissed" is a local fact: the id joins `handledRequestIds` and {@link
   * pending} stops showing it. That half is the whole of what this agent needs, and it
   * happens first, because it cannot fail.
   *
   * The second half is a courtesy to the other side, and it is **best-effort by
   * design**. A decision envelope that does not reach the server leaves them seeing
   * "no answer yet", which is a true statement about what they know; nothing here is
   * shared with them either way. The result says which of the two happened rather than
   * reporting a clean refusal we did not actually deliver.
   *
   * Like {@link accept} this reads the **raw** inbox, not the filtered view: naming an
   * id is a deliberate act, and a request hidden by some display rule must still be
   * answerable. Unlike accept it pins nothing and grants nothing, so a requester whose
   * keys do not match one we already hold is not a mismatch to refuse — they are
   * simply being told no.
   */
  async decline(requestId: number): Promise<DeclineResult> {
    const view = await this.api.getRequestShare(this.identity.uuid);
    const raw = view.requests.find((r) => r.id === requestId);
    if (!raw) {
      throw new NoSuchRequestError(requestId);
    }
    const request = toPendingRequest(raw);
    if (request.requesterUuid === this.identity.uuid) {
      throw new SelfConnectError();
    }
    const current = this.roster.load();
    if (current.connections.some((c) => c.uuid === request.requesterUuid)) {
      throw new ConnectedRequesterError(request.requesterUuid);
    }
    // An id already marked handled was actioned before, so this is a repeat and there
    // is nothing new to record. The decision table keeps the first answer and refuses a
    // differing one, and a fresh envelope is never byte-identical to a stored one, so
    // the 409 a second PUT earns would be reported as a failure that says nothing about
    // what the requester can actually see.
    if (current.handledRequestIds.includes(requestId)) {
      return { request, notified: 'skipped' };
    }
    this.roster.update((r) => withHandledRequest(r, requestId));
    return { request, notified: (await this.tellRequester(request)) ? 'sent' : 'failed' };
  }

  /**
   * PUT the sealed decline for `request`. Never throws: see {@link decline}.
   */
  private async tellRequester(request: PendingRequest): Promise<boolean> {
    try {
      const encKey = new Uint8Array(Buffer.from(request.encKey, 'base64'));
      const recipient = { uuid: request.requesterUuid, x25519PublicKey: encKey };
      const envelope = sealShareResponse(this.crypto, this.identity, request.id, false, recipient);
      await this.api.putShareResponse(request.id, envelope);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop sharing with `uuid`, and rotate this agent's content keys away from them.
   *
   * What revocation does **not** do is take back what they already read. For a peer
   * that is an ordinary limit; when the revoked peer is an agent it reaches further,
   * because that plaintext went to a model provider. The CLI says so; this returns
   * `false` for a uuid we did not hold and changes nothing.
   */
  async revoke(uuid: string): Promise<boolean> {
    if (!this.roster.load().connections.some((c) => c.uuid === uuid)) return false;
    this.roster.update((r) => withoutConnection(r, uuid));
    await this.publishShareDoc();
    await this.onRosterChanged();
    return true;
  }

  /**
   * Publish the roster as the encrypted `share/{uuid}` grant document.
   *
   * This is how the other side learns it was accepted: the app reads its own uuid out
   * of **this envelope's recipient key map** (`SharingManager.refreshInvites`), which
   * is public, so no decryption is involved. Skip it and a connection this agent has
   * in fact accepted shows as "Invited · waiting" in the app forever.
   *
   * Sealed to every connection, cards-only and list-only alike: the grant doc is not
   * one of the scoped resources, it is the record *of* the grant. It carries the
   * roster's public half — uuids, names, public keys — and never card or list content.
   */
  async publishShareDoc(): Promise<number | null> {
    const connections = this.roster.load().connections;
    // A peer that has never shared with anyone writes no share doc at all, matching the
    // app: an empty grant document says nothing and is one more thing to keep in step.
    if (connections.length === 0) return null;
    const recipients = [
      { uuid: this.identity.uuid, x25519PublicKey: this.identity.encPublicKey },
      ...connections.map(toRecipient),
    ];
    return publishResource({
      crypto: this.crypto,
      identity: this.identity,
      state: this.state,
      resourceType: SHARE_TYPE,
      resourceId: this.identity.uuid,
      storeKey: RESOURCE_SHARE,
      plaintext: Buffer.from(encodeShareDoc(connections), 'utf8'),
      recipients,
      put: (envelope) => this.api.putShare(this.identity.uuid, envelope),
      remoteVer: async () => (await this.api.getShare(this.identity.uuid))?.signature?.ver ?? 0,
    });
  }
}

/**
 * The grant document's plaintext, in the shape `sync/sharing/Roster.kt` deserializes.
 *
 * The scope and kind tokens are the **Kotlin enum names**, because that is what reads
 * this document. Everything else about this peer's roster is its own business, but this
 * one file crosses to the app, so it speaks the app's spelling.
 */
export function encodeShareDoc(connections: readonly Connection[]): string {
  return JSON.stringify({
    connections: connections.map((c) => ({
      uuid: c.uuid,
      ...(c.displayName === null ? {} : { displayName: c.displayName }),
      signKey: c.signKey,
      encKey: c.encKey,
      scopes: c.scopes.map((s) => s.toUpperCase()),
      kind: c.kind.toUpperCase(),
    })),
  });
}

/** One inbound request, with the material the operator needs to judge it. */
export interface PendingRequest {
  readonly id: number;
  readonly requesterUuid: string;
  readonly displayName: string | null;
  readonly signKey: string;
  readonly encKey: string;
  readonly createdAt: string;
  /**
   * Grouped hex digest of the requester's encryption key — the number to read out
   * against the app's screen. This is the whole trust step: everything else in the
   * request came through the server.
   */
  readonly safetyNumber: string;
  /** Short fingerprint of the same key, as it appears in an invite link. */
  readonly encKeyFingerprint: string;
  /** What the requester says it is. A claim, and only ever a default for the answer. */
  readonly declaredKind: ConnectionKind;
}

export interface AcceptOptions {
  /** What this agent shares with them. Defaults to both resources. */
  readonly scopes?: readonly ResourceScope[];
  /** The label to record. Defaults to what the requester declared. */
  readonly kind?: ConnectionKind;
}

/** What a {@link ConnectionManager.decline} did, including the half that can fail. */
export interface DeclineResult {
  /** The request that was refused, as the operator saw it. */
  readonly request: PendingRequest;
  /**
   * Whether the requester can now read the refusal:
   * - `sent` — the decision envelope is stored; their app will say "declined".
   * - `failed` — we could not record it, so their app still shows an unanswered invite.
   * - `skipped` — the request was actioned before, so nothing new was written and
   *   whatever the requester could already see is unchanged.
   */
  readonly notified: 'sent' | 'failed' | 'skipped';
}

/** This agent's own uuid asked to connect to itself. Never a real request. */
export class SelfConnectError extends Error {
  constructor() {
    super('that request is from this agent itself');
    this.name = 'SelfConnectError';
  }
}

/** The inbox holds no request with that id. */
export class NoSuchRequestError extends Error {
  constructor(readonly requestId: number) {
    super(`no pending share request with id ${requestId}`);
    this.name = 'NoSuchRequestError';
  }
}

/**
 * A request from an account this agent already shares with. Declining it would tell
 * them "no" while the grant document keeps saying yes — the one answer that would be
 * false — so stopping the sharing is a separate, deliberate act.
 */
export class ConnectedRequesterError extends Error {
  constructor(readonly uuid: string) {
    super(
      `already sharing with ${uuid}, so declining their request would claim something ` +
        `untrue. Stop sharing first with \`tolar-mcp revoke ${uuid}\`.`,
    );
    this.name = 'ConnectedRequesterError';
  }
}

/**
 * A uuid we already pinned came back with different keys. Never silently trusted.
 *
 * Distinct from the transport's `KeyMismatchError` (HTTP 403, the server refusing a
 * signer that does not own a resource): this one is *our* pin failing, which is the
 * check that a compromised server is supposed to trip.
 */
export class ConnectionKeyMismatchError extends Error {
  constructor(readonly uuid: string) {
    super(
      `${uuid} is already connected under different keys — refusing to re-pin. Revoke the ` +
        `existing connection first if this really is the same account with new keys.`,
    );
    this.name = 'ConnectionKeyMismatchError';
  }
}

function toPendingRequest(view: ShareRequestViewDto): PendingRequest {
  const encKey = new Uint8Array(Buffer.from(view.requester.requesterEncKey, 'base64'));
  return {
    id: view.id,
    requesterUuid: view.requester.requesterUuid,
    displayName: view.requester.displayName ?? null,
    signKey: view.requester.requesterSignKey,
    encKey: view.requester.requesterEncKey,
    createdAt: view.createdAt,
    safetyNumber: safetyNumber(encKey),
    encKeyFingerprint: fingerprintOf(encKey),
    declaredKind: connectionKindFromWire(view.requester.kind),
  };
}
