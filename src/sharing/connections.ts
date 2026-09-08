import type { Envelope } from '../crypto/envelope.js';
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
  signingKeyOf,
  toRecipient,
  withConnection,
  withHandledRequest,
  withIndirectPeers,
  withoutConnection,
  type Connection,
  type IndirectPeer,
  type ResourceScope,
  type SkippedPeer,
} from './roster.js';
import type { RosterStore } from './rosterStore.js';
import { sealShareResponse } from './shareResponse.js';
import type { UnreadableReason, UnreadableSource } from './unreadable.js';

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
   *
   * "Already share with" means a **direct** connection. A request from an account this
   * agent knows only indirectly is still waiting for an answer: nobody compared its
   * safety number, its grant is inherited rather than chosen, and accepting it is the
   * operator's chance to set both. Hiding it because a peer vouched for the account
   * would put the one decision this file exists to protect out of reach.
   */
  async pending(): Promise<readonly PendingRequest[]> {
    const view = await this.api.getRequestShare(this.identity.uuid);
    const current = this.roster.load();
    return view.requests
      .filter((r) => !current.handledRequestIds.includes(r.id))
      .filter((r) => r.requester.requesterUuid !== this.identity.uuid)
      .filter(
        (r) =>
          !current.connections.some(
            (c) => c.uuid === r.requester.requesterUuid && c.learnedFrom === null,
          ),
      )
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
      // The operator compared a safety number for this one. That is what direct means.
      learnedFrom: null,
    };
    this.roster.update((r) => withHandledRequest(withConnection(r, connection), requestId));
    // The new connection's own peers are part of the space it just joined this agent
    // to, so they are merged before the re-publish rather than at some later sync —
    // otherwise the first thing the agent writes is sealed to one seat of a room the
    // operator has already opened. Best-effort: the accept is real once the roster and
    // the grant doc say so, and a discovery that could not reach the server must not
    // undo it. The next `connections` or `serve` picks the peers up.
    await this.discoverPeers().catch(() => emptyDiscovery());
    await this.publishShareDoc();
    await this.onRosterChanged();
    // Answer the request where the *server* can see it, not only in our roster
    // (lcm-gxn). `handledRequestIds` is local state: it hides the request here and
    // travels with this config dir and nowhere else.
    //
    // The requester already learns the outcome from the share doc's recipient key
    // map, so this is not how they find out. What it fixes is the other reader of
    // that answer — `requestShare.responded`, which the app's own inbox filter
    // consults (`PendingRequestFilter`) alongside its local handled-ids. Those ids
    // do not survive a restore from a recovery phrase, so with `responded` left
    // false the app re-lists every connection this agent already accepted as an
    // unanswered request, and asks the user to re-authorise peers they are in fact
    // already sharing with. Measured: 5 accepted connections, 0 responded.
    //
    // Best-effort, exactly as in `decline`: the connection is real once the roster
    // and the share doc say so, and a failed PUT here must not undo that.
    await this.tellRequester(request, true);
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
    const connected = current.connections.find((c) => c.uuid === request.requesterUuid);
    if (connected) {
      throw new ConnectedRequesterError(connected.uuid, connected.learnedFrom);
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
   * PUT the sealed decision for `request`. Never throws: see {@link decline}.
   *
   * `accepted` picks which verdict is sealed. Both sides of the answer are recorded
   * the same way so that `requestShare.responded` means "this was answered", rather
   * than "this was refused" — a distinction nothing downstream would survive.
   */
  private async tellRequester(request: PendingRequest, accepted = false): Promise<boolean> {
    try {
      const encKey = new Uint8Array(Buffer.from(request.encKey, 'base64'));
      const recipient = { uuid: request.requesterUuid, x25519PublicKey: encKey };
      const envelope = sealShareResponse(
        this.crypto,
        this.identity,
        request.id,
        accepted,
        recipient,
      );
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
   * `null` for a uuid we did not hold and changes nothing.
   *
   * Indirect peers learned through `uuid` go with it — see {@link
   * import('./roster.js').withoutConnection} — and are named in the result, because an
   * operator revoking one account needs to be told which others stopped being sealed to.
   */
  async revoke(uuid: string): Promise<RevokeResult | null> {
    const before = this.roster.load().connections;
    if (!before.some((c) => c.uuid === uuid)) return null;
    const orphaned = before.filter((c) => c.learnedFrom === uuid);
    this.roster.update((r) => withoutConnection(r, uuid));
    await this.publishShareDoc();
    await this.onRosterChanged();
    return { uuid, orphaned };
  }

  // --- peers of peers (lcm-8lm) -------------------------------------------------

  /**
   * Learn the peers of this agent's peers, and re-seal so they can actually read.
   *
   * ## The defect this exists for
   * A roster built only from accepted requests holds exactly the accounts that ran the
   * connect flow. Two people share a space, one of them connects this agent, and every
   * resource the agent publishes is wrapped to that one account — the other sees no
   * agent and none of its writes, and no key exists anywhere that would open the
   * ciphertext for them. Nothing is malfunctioning; the topology is pairwise and the
   * space is not.
   *
   * ## Where the peers come from, and why that source is trustworthy
   * Each connection publishes `share/{uuid}`, the grant document that records who *they*
   * share with. It is fetched, checked against the signing key **pinned in our roster**,
   * and opened with the content key wrapped to us — the same three steps the card and
   * shopping reads take, for the same reason: a server that swapped a peer's key could
   * otherwise hand us a roster it wrote itself and name any account it liked as a
   * recipient of our cards. A document that fails any of those is reported, not used.
   *
   * ## One hop, deliberately
   * Only **direct** connections' documents are read. Following an indirect peer's
   * document too would let one vouched-for account extend the agent's roster by itself,
   * without bound and without anything the operator could point at; and it would make
   * {@link import('./roster.js').withoutConnection}'s cascade a graph walk instead of
   * one filter. Peers of peers, and no further.
   *
   * Nothing here throws for a peer this agent could not read. A discovery pass is
   * additive, so a partial answer is a real answer — the sources it could not read are
   * returned so a caller can say so rather than implying the space is smaller than it is.
   */
  async syncPeers(): Promise<PeerDiscovery> {
    const discovery = await this.discoverPeers();
    if (discovery.added.length > 0) {
      // A roster entry seals nothing on its own: the recipient map is written at publish
      // time, so a newly learned peer stays unable to read until the next publish. Doing
      // it here is what makes `syncPeers` mean "they can see this agent now".
      await this.publishShareDoc();
      await this.onRosterChanged();
    }
    return discovery;
  }

  /** {@link syncPeers} without the re-publish — for callers that publish anyway. */
  private async discoverPeers(): Promise<PeerDiscovery> {
    const added: Connection[] = [];
    const skipped: SkippedPeer[] = [];
    const unreadable: UnreadableSource[] = [];
    // Snapshot the direct connections first. Merging mutates the roster, and a peer
    // learned in this very pass must not have its own document followed — that is the
    // one-hop rule, and taking the list up front is how it is enforced.
    for (const source of this.roster.load().connections.filter((c) => c.learnedFrom === null)) {
      const peers = await this.readGrantDoc(source);
      if ('reason' in peers) {
        unreadable.push(peers);
        continue;
      }
      const merged = withIndirectPeers(
        this.roster.load(),
        source,
        peers,
        this.identity.uuid,
        this.deps.now?.() ?? Date.now(),
      );
      skipped.push(...merged.skipped);
      if (merged.added.length === 0) continue;
      added.push(...merged.added);
      this.roster.update(() => merged.roster);
    }
    return { added, skipped, unreadable };
  }

  /**
   * Fetch, verify and open one connection's grant document, or say why not.
   *
   * The refusal vocabulary is {@link UnreadableReason}, shared with the card and
   * shopping reads because it is the same question about the same three failures —
   * "did they not give me this, or is there nothing there?" — and a `not_granted` here
   * is the ordinary state of a peer running a version that seals its grant doc to
   * nobody, not an error.
   */
  private async readGrantDoc(
    source: Connection,
  ): Promise<readonly IndirectPeer[] | UnreadableSource> {
    const refusal = (reason: UnreadableReason, detail: string): UnreadableSource => ({
      uuid: source.uuid,
      displayName: source.displayName,
      reason,
      detail,
    });

    let envelope: Envelope | null;
    try {
      envelope = await this.api.getShare(source.uuid);
    } catch (e) {
      return refusal('unreachable', `fetch failed: ${(e as Error).message}`);
    }
    if (!envelope) {
      return refusal('not_published', 'this account has published no grant document yet');
    }
    const signature = envelope.signature;
    if (!signature || signature.by !== source.uuid) {
      return refusal(
        'not_verified',
        'the stored grant document is unsigned, or signed by someone else',
      );
    }
    let signKey: Uint8Array;
    try {
      signKey = signingKeyOf(source);
    } catch (e) {
      return refusal('not_verified', (e as Error).message);
    }
    if (!this.crypto.verify(SHARE_TYPE, source.uuid, envelope, signKey)) {
      return refusal(
        'not_verified',
        'the grant document does not verify against the key pinned for this connection',
      );
    }
    if (envelope.keys[this.identity.uuid] === undefined) {
      return refusal(
        'not_granted',
        'this account published its grant document with no content key wrapped to this ' +
          'agent, so who else it shares with cannot be read, not merely not shown',
      );
    }
    let plaintext: Uint8Array;
    try {
      plaintext = this.crypto.decrypt(
        envelope,
        this.identity.uuid,
        this.identity.encryptionKeyPair,
      );
    } catch (e) {
      return refusal(
        'undecryptable',
        `the wrapped key did not open the grant document: ${(e as Error).message}`,
      );
    }
    try {
      return decodeShareDoc(Buffer.from(plaintext).toString('utf8'));
    } catch (e) {
      return refusal(
        'malformed',
        `the grant document decrypted but did not parse: ${(e as Error).message}`,
      );
    }
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
  // Indirect entries are carried too. The document's job is to say who this agent
  // seals to, and by the time it is written that is exactly the roster — a document
  // that hid the peers it in fact wraps keys to would be the wrong record of the grant,
  // and the app's own Connections screen is where a user notices an account they did
  // not expect. Where the entry came from is this agent's bookkeeping and does not
  // travel: the reader on the other side is one hop from us, whatever we are from them.
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

/**
 * Read a grant document's peer list — the exact inverse of {@link encodeShareDoc}, and
 * kept beside it so the two cannot drift.
 *
 * Every value here was chosen by *another account*, so this parses rather than trusts:
 * the scope and kind tokens are the app's uppercase enum names and anything else reads
 * as the safe default, and the keys are handed on as the strings they arrived as, for
 * {@link withIndirectPeers} to validate and name if they are unusable.
 *
 * An entry with no uuid at all is the one thing dropped silently — there is nothing to
 * name it by, so there is no report to make. A document that is not JSON, or whose
 * `connections` is not an array, throws: that is a malformed source rather than a
 * malformed entry, and the caller reports the whole peer as unreadable.
 *
 * The `scopes` a document carries are **not** read. They are what that peer seals to
 * that entry, about that peer's own data; what this agent seals is decided by the
 * inheritance rule in {@link withIndirectPeers} and by nothing a peer can write.
 */
export function decodeShareDoc(text: string): readonly IndirectPeer[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('a grant document must be a JSON object');
  }
  const raw = (parsed as Record<string, unknown>).connections;
  if (!Array.isArray(raw)) {
    throw new Error('a grant document must carry a `connections` array');
  }
  const peers: IndirectPeer[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.uuid !== 'string' || o.uuid === '') continue;
    peers.push({
      uuid: o.uuid,
      displayName: typeof o.displayName === 'string' ? o.displayName : null,
      // Left as-is when they are not strings: an empty string is not a key, and being
      // refused by name beats being dropped without one.
      signKey: typeof o.signKey === 'string' ? o.signKey : '',
      encKey: typeof o.encKey === 'string' ? o.encKey : '',
      kind: connectionKindFromWire(typeof o.kind === 'string' ? o.kind.toLowerCase() : null),
    });
  }
  return peers;
}

/** What one {@link ConnectionManager.syncPeers} pass found. */
export interface PeerDiscovery {
  /** Accounts newly merged into the roster, each carrying who vouched for it. */
  readonly added: readonly Connection[];
  /** Peers named in a document that did not become connections, and why. */
  readonly skipped: readonly SkippedPeer[];
  /**
   * Connections whose grant document could not be read. Reported rather than swallowed:
   * a pass that reached nobody looks identical to a space with no other people in it,
   * and only one of those is worth telling an operator about.
   */
  readonly unreadable: readonly UnreadableSource[];
}

/** A pass that reached nothing — what a best-effort discovery falls back to. */
function emptyDiscovery(): PeerDiscovery {
  return { added: [], skipped: [], unreadable: [] };
}

/** What a {@link ConnectionManager.revoke} removed: the account, and its dependents. */
export interface RevokeResult {
  readonly uuid: string;
  /**
   * Indirect peers that went with it — accounts whose only claim on this agent's keys
   * was the connection just revoked. Named so the operator sees the full blast radius.
   */
  readonly orphaned: readonly Connection[];
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
  constructor(
    readonly uuid: string,
    /** The connection they were learned through, when this agent knows them indirectly. */
    readonly learnedFrom: string | null = null,
  ) {
    super(
      `already sharing with ${uuid}, so declining their request would claim something ` +
        `untrue. ` +
        (learnedFrom === null
          ? `Stop sharing first with \`tolar-mcp revoke ${uuid}\`.`
          : `This agent shares with them because ${learnedFrom} names them in its grant ` +
            `document, not because anyone accepted them here — so the way to stop is ` +
            `\`tolar-mcp revoke ${learnedFrom}\`, which removes everything learned through ` +
            `that connection. Accepting this request instead is what makes them a ` +
            `connection in their own right, with the scopes you choose.`),
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
