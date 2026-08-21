import { randomUUID } from 'node:crypto';
import type { EnvelopeCrypto } from '../crypto/envelopeCrypto.js';
import type { Identity } from '../crypto/identity.js';
import { mergeCards, type MergedCard, type SharedCards } from '../merge/cardMerge.js';
import { grants, signingKeyOf, toRecipient, type Connection } from '../sharing/roster.js';
import type { RosterStore } from '../sharing/rosterStore.js';
import type { UnreadableReason, UnreadableSource } from '../sharing/unreadable.js';
import { decodeCardsSnapshot, encodeCardsSnapshot } from '../sync/cardSnapshot.js';
import { publishResource } from '../sync/publishResource.js';
import { RESOURCE_CARDS, type SyncStateStore } from '../sync/syncState.js';
import type { TolarApi } from '../sync/tolarApi.js';
import { NO_PHOTOS, barcodeFormatFromName, type BarcodeFormat, type Card } from './card.js';

/** The envelope `resourceType` the cards blob is signed under. */
const CARDS_TYPE = 'cards';

/**
 * The card half of the agent's tool surface (PRD-agent-connection §4.2, §7.3): read
 * every card that has been shared with this agent, and add, edit or delete the cards
 * **this agent authored** — no more, and visibly no less.
 *
 * ## The asymmetry, stated once
 * `cards/{uuid}` is a single blob owned and signed by one author, and the server
 * verifies that signature against that author's user row. There is no slice model and
 * no per-field merge: an agent editing the user's card is not withheld, it is
 * *impossible* — the write would be rejected as a forged signature. So every write
 * here targets this agent's own blob, and an attempt to change somebody else's card
 * fails with {@link CardNotOursError} naming the reason.
 *
 * That is not an agent limitation. A human peer cannot edit your cards either, and
 * parity with a person is the entire point of the connection model (§6).
 *
 * ## The server is the store
 * Unlike the app, this peer keeps no local mirror of its cards: every operation reads
 * the published blob, changes it, and re-publishes. The app is local-first because a
 * phone must work in a tunnel; an agent is a process that either has the network or
 * has nothing useful to do, and a local mirror it forgot to reconcile would be a
 * second source of truth for the one resource whose whole contract is single-author.
 */
export class CardService {
  /** Serializes every operation on this blob, read or write; see {@link exclusive}. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly identity: Identity,
    private readonly api: TolarApi,
    private readonly crypto: EnvelopeCrypto,
    private readonly state: SyncStateStore,
    private readonly roster: RosterStore,
    private readonly deps: CardServiceDeps = {},
  ) {}

  // --- read ---------------------------------------------------------------------

  /**
   * Every card this agent can see: its own, plus each connection's, deduplicated by
   * code — and, separately, every source it could **not** read and why.
   *
   * The refusals are returned rather than swallowed because the interesting failure
   * here is silent: a connection that granted this agent the shopping list but not the
   * cards (lc-chp) publishes a cards envelope with no content key wrapped to us. Drop
   * that quietly and the agent reports "no cards", which reads as "you have none"
   * rather than "you did not give me these" — the one answer that would be a lie.
   */
  async view(): Promise<CardsView> {
    return this.exclusive(() => this.readView());
  }

  /** One merged card by id, or `null` if no visible card carries it. */
  async get(id: string): Promise<{ view: CardsView; card: MergedCard | null }> {
    return this.exclusive(() => this.locate(id));
  }

  /** {@link view} without the queue — for callers already holding it. */
  private async readView(): Promise<CardsView> {
    const own = await this.readOwn();
    const shared: SharedCards[] = [];
    const unreadable: UnreadableSource[] = [];
    for (const connection of this.roster.load().connections) {
      const result = await this.readPeer(connection);
      if ('cards' in result) shared.push(result);
      else unreadable.push(result);
    }
    return {
      cards: mergeCards(own, shared),
      unreadable,
      connectionCount: this.roster.load().connections.length,
    };
  }

  /** {@link get} without the queue — for callers already holding it. */
  private async locate(id: string): Promise<{ view: CardsView; card: MergedCard | null }> {
    const view = await this.readView();
    return { view, card: view.cards.find((c) => c.card.id === id) ?? null };
  }

  // --- write --------------------------------------------------------------------

  /**
   * Add a card. It lands in **this agent's own** list and shows up in the user's grid
   * badged as shared by this agent, deduplicated by code like any peer's — the same
   * thing that happens when a person adds one (§4.2).
   */
  async add(input: NewCard): Promise<Card> {
    const code = normaliseCode(input.barcodeValue ?? null, input.barcodeFormat ?? null);
    const title = requireTitle(input.title);
    return this.exclusive(async () => {
      const own = await this.readOwn();
      const now = this.now();
      const card: Card = {
        id: this.newId(),
        title,
        notes: emptyToNull(input.notes ?? null),
        barcodeValue: code.value,
        barcodeFormat: code.format,
        createdAt: now,
        updatedAt: now,
        sortOrder: nextSortOrder(own),
        photos: NO_PHOTOS,
      };
      await this.publish([...own, card]);
      return card;
    });
  }

  /**
   * Edit a card **this agent authored**. Only the fields `patch` names change, and
   * `updatedAt` moves.
   *
   * @throws {CardNotOursError} if the card belongs to a connected account.
   * @throws {CardNotFoundError} if no visible card carries that id.
   */
  async update(id: string, patch: CardPatch): Promise<Card> {
    return this.exclusive(async () => {
      const own = await this.readOwn();
      const index = own.findIndex((c) => c.id === id);
      if (index < 0) throw await this.notOursOrMissing(id);
      const current = own[index]!;
      const code = patchCode(current, patch);
      const updated: Card = {
        ...current,
        title: patch.title === undefined ? current.title : requireTitle(patch.title),
        notes: patch.notes === undefined ? current.notes : emptyToNull(patch.notes),
        barcodeValue: code.value,
        barcodeFormat: code.format,
        updatedAt: this.now(),
        // Photos are carried through untouched. This peer cannot open a blob, so a
        // re-publish that dropped the pointers would delete the author's photos from
        // every device that has not fetched them yet (lc-mr9).
        photos: current.photos,
      };
      const next = [...own];
      next[index] = updated;
      await this.publish(next);
      return updated;
    });
  }

  /**
   * Delete a card **this agent authored**.
   *
   * No tombstone, unlike a shopping-list item: the cards blob is single-author and
   * published whole, so a card left out of the next publish is gone for everyone and
   * no peer holds a live observation of it to win a merge with. The removal is
   * attributed to this agent by the same provenance its additions carry.
   *
   * @throws {CardNotOursError} if the card belongs to a connected account.
   * @throws {CardNotFoundError} if no visible card carries that id.
   */
  async remove(id: string): Promise<Card> {
    return this.exclusive(async () => {
      const own = await this.readOwn();
      const removed = own.find((c) => c.id === id);
      if (!removed) throw await this.notOursOrMissing(id);
      await this.publish(own.filter((c) => c.id !== id));
      return removed;
    });
  }

  /**
   * Re-publish this agent's card list unchanged, so the envelope's recipient set is
   * rebuilt from the current roster.
   *
   * This is the cards half of the app's `onRosterChanged`. Accepting a connection
   * re-wraps the content key to them; revoking mints a fresh key and does not wrap it to
   * them, which rotates them out for everything published from here on. What they
   * already fetched is theirs — no publish can reach back and take it.
   */
  async republish(): Promise<number> {
    return this.exclusive(async () => this.publish(await this.readOwn()));
  }

  // --- internals ----------------------------------------------------------------

  /**
   * This agent's own published cards.
   *
   * Every failure here throws. A read this peer cannot make sense of must never
   * degrade to "no cards": the next write would publish that empty list over a blob
   * that is fine, and delete every card this agent has ever added. `null` from the
   * API is the one safe empty — the server has no blob at this address, so there is
   * nothing to destroy.
   */
  private async readOwn(): Promise<readonly Card[]> {
    const uuid = this.identity.uuid;
    const envelope = await this.api.getCards(uuid);
    if (!envelope) return [];
    const signature = envelope.signature;
    if (!signature || signature.by !== uuid) {
      throw new CardStoreError(
        `the cards blob stored for this agent is not signed by it — refusing to overwrite it`,
      );
    }
    if (!this.crypto.verify(CARDS_TYPE, uuid, envelope, this.identity.signPublicKey)) {
      throw new CardStoreError(
        `the cards blob stored for this agent fails its own signature — refusing to overwrite it`,
      );
    }
    this.state.setLastVer(RESOURCE_CARDS, signature.ver);
    let plaintext: Uint8Array;
    try {
      plaintext = this.crypto.decrypt(envelope, uuid, this.identity.encryptionKeyPair);
    } catch (e) {
      throw new CardStoreError(
        `this agent's own cards blob will not open with this host's key — a different ` +
          `recovery phrase wrote it (${(e as Error).message})`,
        { cause: e },
      );
    }
    return decodeCardsSnapshot(Buffer.from(plaintext).toString('utf8')).cards;
  }

  /**
   * Fetch, verify and decrypt one connection's cards, or say why not.
   *
   * Verification is against the key **pinned in the roster**, never the server's live
   * answer: a server that swapped a peer's key could otherwise hand us a card list it
   * wrote itself. A peer whose signature does not check out is reported as unverified
   * rather than skipped, because "I did not show you these" and "you have none" are
   * different sentences.
   */
  private async readPeer(connection: Connection): Promise<SharedCards | UnreadableSource> {
    const refusal = (reason: UnreadableReason, detail: string): UnreadableSource => ({
      uuid: connection.uuid,
      displayName: connection.displayName,
      reason,
      detail,
    });

    const envelope = await this.api.getCards(connection.uuid).catch((e: unknown) => {
      return new CardStoreError(`fetch failed: ${(e as Error).message}`);
    });
    if (envelope instanceof CardStoreError) return refusal('unreachable', envelope.message);
    if (!envelope) {
      return refusal('not_published', 'this account has not published a card list yet');
    }

    const signature = envelope.signature;
    if (!signature || signature.by !== connection.uuid) {
      return refusal('not_verified', 'the stored card list is unsigned, or signed by someone else');
    }
    let signKey: Uint8Array;
    try {
      signKey = signingKeyOf(connection);
    } catch (e) {
      return refusal('not_verified', (e as Error).message);
    }
    if (!this.crypto.verify(CARDS_TYPE, connection.uuid, envelope, signKey)) {
      return refusal(
        'not_verified',
        'the card list does not verify against the key pinned for this connection',
      );
    }

    if (envelope.keys[this.identity.uuid] === undefined) {
      return refusal(
        'not_granted',
        'this account has not granted this agent its cards — the card list is published ' +
          'with no content key wrapped to us, so it cannot be read, not merely not shown',
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
        `the wrapped key did not open the card list: ${(e as Error).message}`,
      );
    }
    try {
      return {
        authorUuid: connection.uuid,
        displayName: connection.displayName,
        kind: connection.kind,
        cards: decodeCardsSnapshot(Buffer.from(plaintext).toString('utf8')).cards,
      };
    } catch (e) {
      return refusal(
        'malformed',
        `the card list decrypted but did not parse: ${(e as Error).message}`,
      );
    }
  }

  /** Seal `cards` to ourselves plus every connection granted the cards scope, and PUT it. */
  private async publish(cards: readonly Card[]): Promise<number> {
    await this.deps.ensureRegistered?.();
    const recipients = [
      { uuid: this.identity.uuid, x25519PublicKey: this.identity.encPublicKey },
      ...this.roster
        .load()
        .connections.filter((c) => grants(c, 'cards'))
        .map(toRecipient),
    ];
    return publishResource({
      crypto: this.crypto,
      identity: this.identity,
      state: this.state,
      resourceType: CARDS_TYPE,
      resourceId: this.identity.uuid,
      storeKey: RESOURCE_CARDS,
      plaintext: Buffer.from(encodeCardsSnapshot(cards), 'utf8'),
      recipients,
      put: (envelope) => this.api.putCards(this.identity.uuid, envelope),
      remoteVer: async () => (await this.api.getCards(this.identity.uuid))?.signature?.ver ?? 0,
    });
  }

  /**
   * The error for an id that is not in our own list: whose card it is if we can see
   * it, and not-found if we cannot.
   *
   * Naming the owner is the point. An agent that answered "no such card" for a card
   * the user is looking straight at would send them hunting for a typo instead of
   * telling them the truth, which is that this card is theirs and stays theirs.
   */
  private async notOursOrMissing(id: string): Promise<CardNotOursError | CardNotFoundError> {
    const { card } = await this.locate(id);
    if (card && card.provenance.kind === 'sharedBy') {
      return new CardNotOursError(id, card.provenance.authorUuid, card.provenance.displayName);
    }
    return new CardNotFoundError(id);
  }

  /**
   * Run `body` after everything already queued — **reads included**.
   *
   * Two reasons, and the second one is the load-bearing one.
   *
   * Each write is a read-modify-write of one whole blob, so two of them in flight at
   * once would have the second overwrite the first with state read before it — and the
   * server's version check cannot catch that, because both writes are legitimately
   * ours.
   *
   * And a read that does not queue answers from before a write this same session has
   * already reported as done (lcm-8wb). MCP tool calls do not arrive one at a time: a
   * model that adds a card and reads the list back in one turn has both calls dispatched
   * together, the GET beats the PUT to the server, and the answer is the account as it
   * was — a genuine, non-refusal empty result that is false. That is the one input the
   * empty-vs-refusal distinction in `mcp/server.ts` cannot defend against, because
   * nothing distinguishes it from a real empty list; the agent then tells the user they
   * have no cards moments after adding one. So the queue is the whole surface of this
   * blob, not just its writes, and a read taken after a write in call order sees it.
   */
  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this.writes.then(body, body);
    // Keep the chain alive even when this call rejects: the next writer must still run.
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }
}

/** Injection seams: the clock, the id source, and the one-time user-row publish. */
export interface CardServiceDeps {
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Publish this peer's user row if the server does not have it — the server resolves
   * our signing key from it to verify anything we write.
   */
  readonly ensureRegistered?: () => Promise<unknown>;
}

/** What the agent can see, and what it could not. */
export interface CardsView {
  readonly cards: readonly MergedCard[];
  readonly unreadable: readonly UnreadableSource[];
  /**
   * How many accounts this agent is connected to. Zero is its own answer: nobody has
   * accepted this agent yet, which is a different thing from a connection that shared
   * nothing, and the caller should be told which one it is looking at.
   */
  readonly connectionCount: number;
}

/**
 * Why one connection's cards did not make it into the view — the shared vocabulary in
 * {@link import('../sharing/unreadable.js')}, re-exported so a caller holding a
 * {@link CardsView} has the type to hand.
 */
export type { UnreadableReason, UnreadableSource };

/** Fields for a new card. `barcodeFormat` is required whenever `barcodeValue` is set. */
export interface NewCard {
  readonly title: string;
  readonly notes?: string | null;
  readonly barcodeValue?: string | null;
  readonly barcodeFormat?: string | null;
}

/** Fields to change. Absent means "leave alone"; `null` means "clear". */
export interface CardPatch {
  readonly title?: string;
  readonly notes?: string | null;
  readonly barcodeValue?: string | null;
  readonly barcodeFormat?: string | null;
}

/** The card exists and belongs to a connected account, so this agent cannot touch it. */
export class CardNotOursError extends Error {
  constructor(
    readonly cardId: string,
    readonly authorUuid: string,
    readonly authorName: string | null,
  ) {
    super(
      `cards belong to the account that created them: ${cardId} was created by ` +
        `${authorName ?? authorUuid} and only they can change or delete it. This agent can ` +
        `read it, and can add cards of its own, exactly as any connected person could.`,
    );
    this.name = 'CardNotOursError';
  }
}

/** No card with that id is visible to this agent at all. */
export class CardNotFoundError extends Error {
  constructor(readonly cardId: string) {
    super(`no card with id ${cardId} is visible to this agent`);
    this.name = 'CardNotFoundError';
  }
}

/** This agent's own card blob is in a state it refuses to overwrite. */
export class CardStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CardStoreError';
  }
}

/** A field the caller supplied is not usable. */
export class CardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardInputError';
  }
}

function requireTitle(title: string): string {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) throw new CardInputError('a card needs a title');
  return trimmed;
}

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nextSortOrder(cards: readonly Card[]): number {
  return cards.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
}

/**
 * A code and the symbology that draws it, or neither.
 *
 * A value without a format is rejected rather than stored. The grid dedups on the pair
 * (see `mergeCards`), so a code filed under "no format" does not collide with the same
 * code the user already holds under `EAN_13` — the user gets a duplicate tile instead
 * of the dedup the merge exists to provide. The app never writes that combination; an
 * agent should not be the first.
 */
function normaliseCode(
  value: string | null,
  format: string | null,
): { value: string | null; format: BarcodeFormat | null } {
  const code = emptyToNull(value);
  const name = emptyToNull(format);
  if (!code) {
    if (name) {
      throw new CardInputError('barcodeFormat was given without a barcodeValue to draw');
    }
    return { value: null, format: null };
  }
  if (!name) {
    throw new CardInputError(
      'a card with a barcodeValue needs its barcodeFormat too, or the grid cannot ' +
        'recognise it as the same card the account already holds',
    );
  }
  const parsed = barcodeFormatFromName(name);
  if (!parsed) throw new CardInputError(`unknown barcodeFormat: ${name}`);
  return { value: code, format: parsed };
}

/** Apply a patch's code fields on top of a card's current pair, then re-validate. */
function patchCode(
  current: Card,
  patch: CardPatch,
): { value: string | null; format: BarcodeFormat | null } {
  if (patch.barcodeValue === undefined && patch.barcodeFormat === undefined) {
    return { value: current.barcodeValue, format: current.barcodeFormat };
  }
  return normaliseCode(
    patch.barcodeValue === undefined ? current.barcodeValue : patch.barcodeValue,
    patch.barcodeFormat === undefined ? current.barcodeFormat : patch.barcodeFormat,
  );
}
