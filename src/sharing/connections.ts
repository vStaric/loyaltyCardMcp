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
  evictionOf,
  signingKeyOf,
  toRecipient,
  withConnection,
  withEviction,
  withHandledRequest,
  withIndirectPeers,
  withoutConnection,
  withoutEvicted,
  type Connection,
  type Eviction,
  type IndirectPeer,
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
 * `leave`, by the person who set the agent up. That person is also the only one who
 * can do the part that carries the trust — comparing the safety number against the one
 * the app is showing.
 *
 * ## Why there is no way to remove somebody else
 * A household is a group of people and agents who all see each other, and its members
 * may kick a member out. **This agent is not one of the parties that may** (lc-gx2w).
 * Until lcm-9m7 it was: `revoke <uuid>` dropped any account in the roster and took
 * everything learned through it along, which is exactly the capability the spec denies
 * it. So the verb is gone rather than renamed, and what replaces it is {@link leave} —
 * the agent walking out, which needs nobody's permission and is the operator's local
 * off switch if a household turns out to be the wrong one.
 *
 * The other half is {@link syncPeers}: an eviction a member publishes is **obeyed**
 * here. The agent honours evictions and issues none.
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
     * re-wraps the content key to the new peer; a departure or an eviction mints a fresh
     * one and does not wrap it to them (best-effort forward secrecy — what they already
     * fetched cannot be un-fetched).
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
   * safety number, and it is in the household because a peer named it rather than
   * because the operator approved it. Accepting is that approval. Hiding the request
   * because a peer vouched for the account would put the one decision this file exists
   * to protect out of reach.
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
   * must still meet the pin. It is also what makes re-accepting a peer this agent left,
   * or one a household evicted and later invited back, work: their request is long since
   * marked handled, and naming its id is a deliberate act.
   *
   * There is nothing to choose about *what* is shared: accepting is admission to the
   * household, and a household member is sealed every resource (lcm-hfd). What they
   * share with **us** is still their decision, made on their accept screen; this cannot
   * set it and does not pretend to.
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
    const now = this.deps.now?.() ?? Date.now();
    const connection: Connection = {
      uuid: request.requesterUuid,
      displayName: request.displayName,
      signKey: request.signKey,
      encKey: request.encKey,
      kind: options.kind ?? request.declaredKind,
      connectedAt: now,
      // This host's operator admitted them, just now, having compared a safety number.
      // That act is what an eviction older than it is measured against, and it is the
      // one admission this agent can date from a clock it owns (lcm-9m7).
      admittedAt: now,
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
   * Walk out: this agent leaves every household it is in (lcm-9m7).
   *
   * ## Why this takes no argument
   * A uuid parameter is exactly the shape of the capability the spec denies this agent.
   * Members of a household may remove a member; the agent may not, and the cheapest way
   * to make that true of the shipping agent — rather than true of a rule somebody could
   * edit out — is for there to be no expression in the CLI or in this class that names
   * an account to remove. What is left is a door the agent can only walk out of itself,
   * which is nobody's business but the operator's and needs no permission.
   *
   * The cost is real and is stated in the README: an operator who wants out of one
   * household but not another leaves both and accepts the one they are keeping again.
   * That is the trade for having no verb that could ever be pointed at somebody else.
   *
   * ## Two halves, and only one of them can fail
   * The local half — the roster is emptied and the next publish seals to nobody — cannot
   * fail and happens whatever the network does. That matters: this is the operator's off
   * switch, and an off switch that needs a server is not one.
   *
   * The notice is best-effort, exactly as in {@link decline}. It is a final grant
   * document sealed to the members being left, carrying no connections and one eviction
   * naming **this agent** — the only eviction this agent ever authors, and the one the
   * household needs in order to drop it rather than keep a member that has gone quiet.
   * The result says which of the two happened rather than reporting a clean departure
   * that nobody was told about.
   *
   * What leaving does **not** do is take back what anyone already read. For a peer that
   * is an ordinary limit; here it reaches further, because that plaintext went to a model
   * provider. The CLI says so.
   */
  async leave(): Promise<LeaveResult> {
    const left = this.roster.load().connections;
    if (left.length === 0) return { left: [], notified: 'skipped' };
    const at = this.deps.now?.() ?? Date.now();
    const notified = await this.publishDeparture(left, at);
    this.roster.update((r) => ({ ...r, connections: [] }));
    await this.onRosterChanged();
    return { left, notified };
  }

  /**
   * Publish the final grant document that says this agent is out. Never throws.
   *
   * Sealed to the members being left, because a document they cannot open tells them
   * nothing; and published **before** the roster is emptied, since they are the
   * recipients. The body carries no connections — this agent shares with nobody as of
   * now — and the departure record.
   */
  private async publishDeparture(
    left: readonly Connection[],
    at: number,
  ): Promise<'sent' | 'failed'> {
    const departure: Eviction = {
      uuid: this.identity.uuid,
      at,
      by: this.identity.uuid,
      learnedFrom: this.identity.uuid,
    };
    try {
      await publishResource({
        crypto: this.crypto,
        identity: this.identity,
        state: this.state,
        resourceType: SHARE_TYPE,
        resourceId: this.identity.uuid,
        storeKey: RESOURCE_SHARE,
        plaintext: Buffer.from(encodeShareDoc([], [departure]), 'utf8'),
        recipients: [
          { uuid: this.identity.uuid, x25519PublicKey: this.identity.encPublicKey },
          ...left.map(toRecipient),
        ],
        put: (envelope) => this.api.putShare(this.identity.uuid, envelope),
        remoteVer: async () => (await this.api.getShare(this.identity.uuid))?.signature?.ver ?? 0,
      });
      return 'sent';
    } catch {
      return 'failed';
    }
  }

  /**
   * The evictions this agent is honouring **right now**, including any naming the agent
   * itself.
   *
   * Not every record it holds. A tombstone is kept once read and is re-read from the
   * publisher's document on every pass — the document goes on saying it — but it stops
   * being *in force* the moment something later outranks it: the operator accepting that
   * account here, or an introducer dating their admission after it. The roster is the
   * outcome of that comparison, so this reads the answer off the roster rather than
   * re-deriving it.
   *
   * The distinction is what `tolar-mcp connections` needs. Printing a held record for an
   * account that is sitting in the list above it would be two contradictory statements
   * about one present, and the operator has no way to tell which one to believe.
   */
  evictions(): readonly Eviction[] {
    const roster = this.roster.load();
    const connected = (uuid: string): boolean => roster.connections.some((c) => c.uuid === uuid);
    return roster.evictions.filter((e) =>
      // An eviction naming this agent is in force while this agent is out of that
      // household, and the member who told us is how that household is named here.
      e.uuid === this.identity.uuid ? !connected(e.learnedFrom) : !connected(e.uuid),
    );
  }

  /**
   * The eviction that has this agent out of a household, or `null` — what
   * `tolar-mcp connections` prints instead of letting the agent look connected.
   */
  evictedSelf(): Eviction | null {
    return this.evictions().find((e) => e.uuid === this.identity.uuid) ?? null;
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
   * ## It is also where evictions are obeyed (lcm-9m7)
   * The same documents carry the household's evictions, and this is the pass that
   * honours them: an evicted account leaves the roster and stops being sealed to, and an
   * eviction naming **this agent** is a household showing it the door, which it takes by
   * leaving that household rather than by going on publishing to it.
   *
   * Nothing here throws for a peer this agent could not read. A discovery pass is
   * additive, so a partial answer is a real answer — the sources it could not read are
   * returned so a caller can say so rather than implying the space is smaller than it is.
   */
  async syncPeers(): Promise<PeerDiscovery> {
    const discovery = await this.discoverPeers();
    if (discovery.added.length > 0 || discovery.evicted.length > 0) {
      // A roster entry seals nothing on its own: the recipient map is written at publish
      // time, so a newly learned peer stays unable to read until the next publish. Doing
      // it here is what makes `syncPeers` mean "they can see this agent now".
      await this.publishShareDoc();
      await this.onRosterChanged();
    }
    return discovery;
  }

  /**
   * {@link syncPeers} without the re-publish — for callers that publish anyway.
   *
   * Three phases, and the order is the design rather than an implementation detail.
   * **Read** every direct connection's document first; then apply the **evictions** they
   * carry; then **merge** the peers they name, and subtract once more at the end.
   *
   * That last "once more" is the subtract-last rule lc-gx2w specifies, and it is what a
   * derived membership needs in order to be evictable at all: A's document may still
   * list an account B's document declares out, and whichever happened to be fetched
   * first must not decide the answer. Reading everything before writing anything is how
   * the fetch order stops mattering.
   */
  private async discoverPeers(): Promise<PeerDiscovery> {
    const added: Connection[] = [];
    const skipped: SkippedPeer[] = [];
    const unreadable: UnreadableSource[] = [];
    const now = this.deps.now?.() ?? Date.now();
    // Snapshot the direct connections first. Merging mutates the roster, and a peer
    // learned in this very pass must not have its own document followed — that is the
    // one-hop rule, and taking the list up front is how it is enforced.
    const sources = this.roster.load().connections.filter((c) => c.learnedFrom === null);
    const documents: { source: Connection; doc: ShareDoc }[] = [];
    for (const source of sources) {
      const doc = await this.readGrantDoc(source);
      if ('reason' in doc) {
        unreadable.push(doc);
        continue;
      }
      documents.push({ source, doc });
    }

    const evicted: Eviction[] = [];
    for (const { source, doc } of documents) {
      for (const record of doc.evictions) {
        const eviction: Eviction = {
          uuid: record.uuid,
          // An undated record is read as "now" rather than discarded. The two ways of
          // being wrong are not symmetric: honouring an eviction that should not have
          // applied costs one re-accept, and ignoring a real one leaves an account the
          // household removed still being sealed to — the failure the record exists for.
          at: record.at ?? now,
          by: record.by ?? source.uuid,
          learnedFrom: source.uuid,
        };
        const before = this.roster.load();
        const applied = withEviction(before, eviction);
        // An eviction naming this agent is the household showing it the door. No entry in
        // our own roster carries our uuid, so the door has to be walked out of
        // explicitly: the connection that told us goes, and everything learned through it
        // goes with it. Unless the operator accepted that connection *after* the
        // eviction, which is a re-invitation and outranks it, exactly as for any peer.
        const next =
          eviction.uuid === this.identity.uuid && source.admittedAt <= eviction.at
            ? withoutConnection(applied, source.uuid)
            : applied;
        // A record this agent has already obeyed is read again on every pass, because the
        // document that carries it does not go away. Only a real change is written and
        // reported: otherwise every pass would re-publish and every `connections` run
        // would announce an eviction that happened once, days ago.
        const changed =
          next.connections.length !== before.connections.length ||
          next.evictions.length !== before.evictions.length ||
          evictionOf(before, eviction.uuid)?.at !== evictionOf(next, eviction.uuid)?.at;
        if (!changed) continue;
        this.roster.save(next);
        evicted.push(eviction);
      }
    }

    for (const { source, doc } of documents) {
      // The source may have gone in the phase above: it carried an eviction naming this
      // agent, or another member evicted it. A household this agent has left, or a
      // member the household removed, teaches it nothing.
      if (!this.roster.load().connections.some((c) => c.uuid === source.uuid)) continue;
      const merged = withIndirectPeers(
        this.roster.load(),
        source,
        doc.peers,
        this.identity.uuid,
        now,
      );
      skipped.push(...merged.skipped);
      if (merged.added.length === 0) continue;
      added.push(...merged.added);
      this.roster.update(() => merged.roster);
    }

    // Subtract last. Everything above merged from documents that can disagree with each
    // other; this is the line that decides which side of the disagreement wins.
    this.roster.update((r) => ({ ...r, connections: withoutEvicted(r.connections, r.evictions) }));
    const survived = new Set(this.roster.load().connections.map((c) => c.uuid));
    return { added: added.filter((c) => survived.has(c.uuid)), skipped, unreadable, evicted };
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
  private async readGrantDoc(source: Connection): Promise<ShareDoc | UnreadableSource> {
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
   * Sealed to every member: the grant doc is not one of the resources, it is the record
   * *of* the household. It carries the roster's public half — uuids, names, public keys
   * — and never card or list content.
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
export function encodeShareDoc(
  connections: readonly Connection[],
  /**
   * Evictions to carry. In practice this is only ever **this agent's own departure**,
   * written by {@link ConnectionManager.leave} and by nothing else.
   *
   * ## Why the agent never relays somebody else's eviction
   * lc-gx2w has a member who reads an eviction republish it, so the removal floods the
   * household instead of being one device's private opinion. This agent deliberately
   * does not do that half. A reader verifies the *document's* signature — ours — and
   * has no way to check the `by` field inside it, so a relayed eviction and an authored
   * one are the same bytes to everyone downstream. Flooding would hand the agent the
   * eviction power through the back door, three lines after the front door was removed.
   *
   * So the agent obeys evictions locally and republishes none of them. The cost is that
   * it is not a relay hop for the flood; every member's own document carries the record
   * to every member it shares with, which is where the flooding lc-gx2w wants comes from.
   */
  evictions: readonly Eviction[] = [],
): string {
  // Every entry carries every scope, because that is what this agent in fact seals to
  // every member (lcm-hfd). The field stays on the wire — the app's `Roster.kt` reads
  // it — but it is written from the rule rather than from anything per-member, so the
  // document cannot say one member gets less than another while the recipient map says
  // otherwise. A document that under-reported what it wraps keys to would be the wrong
  // record of the grant.
  const scopes = ALL_SCOPES.map((s) => s.toUpperCase());
  // Indirect entries are carried too. The document's job is to say who this agent
  // seals to, and by the time it is written that is exactly the roster — and the app's
  // own Connections screen is where a user notices an account they did not expect.
  // Where the entry came from is this agent's bookkeeping and does not travel: the
  // reader on the other side is one hop from us, whatever we are from them.
  return JSON.stringify({
    connections: connections.map((c) => ({
      uuid: c.uuid,
      ...(c.displayName === null ? {} : { displayName: c.displayName }),
      signKey: c.signKey,
      encKey: c.encKey,
      scopes,
      kind: c.kind.toUpperCase(),
      // Only for the accounts *this* host admitted. An indirect entry is relayed, and
      // dating a relay with our own clock would say we admitted an account we did not —
      // and would let every re-derivation outrank every eviction. Undated is the honest
      // answer for a peer we were merely told about (lcm-9m7).
      ...(c.learnedFrom === null ? { admittedAtMillis: c.admittedAt } : {}),
    })),
    // Omitted entirely when there are none, so an ordinary document stays byte-identical
    // to the one this agent has always written.
    ...(evictions.length === 0
      ? {}
      : { evictions: evictions.map((e) => ({ uuid: e.uuid, atMillis: e.at, by: e.by })) }),
  });
}

/**
 * One eviction exactly as a grant document spelt it — a claim relayed by a peer, with
 * the two fields that may be missing left missing rather than filled in here.
 *
 * `at` is `null` for a record carrying no readable `atMillis`, and the caller decides
 * what an undated eviction means; see {@link ConnectionManager.syncPeers}. `by` is
 * `null` when the document did not say who authored it, which is a claim in any case —
 * the signature covers the document, not the field.
 */
export interface ShareDocEviction {
  readonly uuid: string;
  readonly at: number | null;
  readonly by: string | null;
}

/** A grant document as read: who that account shares with, and who it says is out. */
export interface ShareDoc {
  readonly peers: readonly IndirectPeer[];
  readonly evictions: readonly ShareDocEviction[];
}

/**
 * Read a grant document — the exact inverse of {@link encodeShareDoc}, and kept beside
 * it so the two cannot drift.
 *
 * Every value here was chosen by *another account*, so this parses rather than trusts:
 * the kind token is the app's uppercase enum name and anything else reads as the safe
 * default, and the keys are handed on as the strings they arrived as, for {@link
 * withIndirectPeers} to validate and name if they are unusable.
 *
 * An entry with no uuid at all is the one thing dropped silently — there is nothing to
 * name it by, so there is no report to make. A document that is not JSON, or whose
 * `connections` is not an array, throws: that is a malformed source rather than a
 * malformed entry, and the caller reports the whole peer as unreadable. An `evictions`
 * field that is not an array is read as no evictions rather than as a malformed
 * document: it is the newer half of the contract, and a peer that spells it wrongly
 * must not cost this agent the peer list it spelt correctly.
 *
 * The `scopes` a document carries are **not** read, and {@link IndirectPeer} has
 * nowhere to put them. They are what that peer seals to that entry, about that peer's
 * own data. What this agent seals is decided by household membership (lcm-hfd) and by
 * nothing a peer can write — the rule the scopes were carefully kept out of when they
 * still varied, and which holds all the more now that there is no per-member width for
 * a document to reach for.
 */
export function decodeShareDoc(text: string): ShareDoc {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('a grant document must be a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  const raw = doc.connections;
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
      // Absent from every document written before evictions existed, and absent from the
      // relayed entries of every document written since. Unknown, not now: see
      // {@link import('./roster.js').evicts}.
      admittedAt: readMillis(o.admittedAtMillis) ?? 0,
    });
  }
  const evictions: ShareDocEviction[] = [];
  for (const entry of Array.isArray(doc.evictions) ? doc.evictions : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.uuid !== 'string' || o.uuid === '') continue;
    evictions.push({
      uuid: o.uuid,
      at: readMillis(o.atMillis),
      by: typeof o.by === 'string' && o.by !== '' ? o.by : null,
    });
  }
  return { peers, evictions };
}

/** Epoch millis a peer wrote, or `null` for anything that is not a usable one. */
function readMillis(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
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
  /**
   * Evictions this pass read and obeyed (lcm-9m7) — including any that named this agent
   * itself. Reported for the same reason the roster marks indirect entries: an account
   * leaving is something the operator has to be able to see a reason for, and "it is not
   * in the list any more" is not one.
   */
  readonly evicted: readonly Eviction[];
}

/** A pass that reached nothing — what a best-effort discovery falls back to. */
function emptyDiscovery(): PeerDiscovery {
  return { added: [], skipped: [], unreadable: [], evicted: [] };
}

/** What a {@link ConnectionManager.leave} did. */
export interface LeaveResult {
  /**
   * The connections this agent walked away from — every one it had. Named so the
   * operator sees the full blast radius of a command that takes no argument.
   */
  readonly left: readonly Connection[];
  /**
   * Whether the households were told, on the same three terms as {@link DeclineResult}:
   * - `sent` — the departure document is stored; their app can drop this agent.
   * - `failed` — it is not, so they still hold a member that has in fact gone. This
   *   agent shares nothing with them either way.
   * - `skipped` — there was nobody to tell.
   */
  readonly notified: 'sent' | 'failed' | 'skipped';
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
 *
 * The advice it gives is `leave`, because that is the only act of this kind the agent
 * has left. It removes this agent from every household rather than removing one account
 * from the roster, and the message says so rather than implying a narrower tool exists
 * (lcm-9m7). Removing one member is the household's to do, in the app.
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
          ? `To stop, either remove this agent from the household in the app, or run ` +
            `\`tolar-mcp leave\` — which walks this agent out of every household it is in.`
          : `This agent shares with them because ${learnedFrom} names them in its grant ` +
            `document, not because anyone accepted them here — so this agent cannot stop ` +
            `sharing with them alone. Removing them is for a member of the household to ` +
            `do in the app; \`tolar-mcp leave\` is the other end of it and takes this ` +
            `agent out of every household. Accepting this request instead is what makes ` +
            `them a connection in their own right, approved here rather than vouched ` +
            `for — not a narrower share, of which there is none.`),
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
