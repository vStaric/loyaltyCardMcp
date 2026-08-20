import type { EnvelopeCrypto } from '../crypto/envelopeCrypto.js';
import type { Envelope } from '../crypto/envelope.js';
import type { Identity } from '../crypto/identity.js';
import { grants, signingKeyOf, toRecipient, type Connection } from '../sharing/roster.js';
import type { RosterStore } from '../sharing/rosterStore.js';
import type { UnreadableReason, UnreadableSource } from '../sharing/unreadable.js';
import { publishResource } from '../sync/publishResource.js';
import { RESOURCE_SHOPPING, type SyncStateStore } from '../sync/syncState.js';
import type { TolarApi } from '../sync/tolarApi.js';
import { mergeShoppingSlices, type AuthorSlice, type MergedShoppingList } from './merge.js';
import {
  decodeShoppingSnapshotBytes,
  encodeShoppingSnapshotBytes,
  EMPTY_SNAPSHOT,
  type ShoppingListSnapshot,
} from './snapshot.js';
import type { WriteContext, WriteResult } from './writer.js';

/** The envelope `resourceType` a shopping-list slice is signed under. */
const SHOPPINGLIST_TYPE = 'shoppinglist';

/**
 * The shopping half of the agent's tool surface (PRD-agent-connection §4.1, §7.3):
 * read the shared list, and write to it with the powers a human peer has — which on
 * this resource is all of them.
 *
 * ## The symmetry, stated once
 * Cards are single-author and the agent cannot touch the user's
 * ({@link import('../cards/cardService.js').CardService} says so at length). The
 * shopping list is the opposite and for a structural reason, not a policy one: it is
 * already multi-writer. Each author publishes their own slice at
 * `shoppinglist/{listId}::{authorUuid}` and every device reconstructs the list by
 * merging them, so an agent editing the user's item is not a privilege — it is one more
 * author publishing one more observation, exactly as a second phone does.
 *
 * The agent still never writes another account's resource. It cannot: the server
 * verifies the signature inside the envelope against the author's user row. Every write
 * here lands in *our* slice and reaches the user because their app merges it.
 *
 * ## The server is the store
 * Like the card service, this peer keeps no local mirror: every write re-reads the
 * published slice, changes it and re-publishes. And with the same load-bearing failure
 * mode — a slice we cannot read or open **fails the write** rather than starting from
 * empty, because publishing an empty slice over a good one would drop every item this
 * agent holds, with a success reported to the model. An *absent* slice is the one safe
 * empty: the server has nothing at that address, so there is nothing to destroy.
 */
export class ShoppingService {
  /** Serializes read-modify-write publishes; see {@link exclusive}. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly identity: Identity,
    private readonly api: TolarApi,
    private readonly crypto: EnvelopeCrypto,
    private readonly state: SyncStateStore,
    private readonly roster: RosterStore,
    private readonly deps: ShoppingServiceDeps = {},
  ) {}

  /** Our own list id equals our uuid; the slice is `listId::authorUuid` with both = us. */
  private get ownSliceResourceId(): string {
    return `${this.identity.uuid}::${this.identity.uuid}`;
  }

  // --- read -------------------------------------------------------------------------

  /**
   * The shared list: our slice merged with every connection's, plus every source that
   * could **not** be read and why.
   *
   * The refusals are returned rather than swallowed for the reason the card view returns
   * them: a connection that granted this agent the cards but not the shopping list
   * publishes a slice with no content key wrapped to us, and dropping that quietly makes
   * the agent say "your list is empty" — which reads as "you have nothing to buy" rather
   * than "you did not give me this".
   */
  async view(): Promise<ShoppingView> {
    const own = await this.readOwn();
    const slices: AuthorSlice[] = [
      { authorUuid: this.identity.uuid, displayName: null, snapshot: own },
    ];
    const unreadable: UnreadableSource[] = [];
    for (const connection of this.roster.load().connections) {
      const result = await this.readPeer(connection);
      if ('snapshot' in result) slices.push(result);
      else unreadable.push(result);
    }
    return {
      own,
      list: mergeShoppingSlices(slices, this.identity.uuid),
      unreadable,
      connectionCount: this.roster.load().connections.length,
    };
  }

  // --- write ------------------------------------------------------------------------

  /**
   * Apply one write to our slice and publish it.
   *
   * `write` is one of the pure operations in {@link import('./writer.js')} — where the
   * stamp discipline lives — and it receives the list as it stands at the moment of the
   * write, never a snapshot the caller has been holding.
   */
  async apply<T>(write: (ctx: WriteContext) => WriteResult<T>): Promise<Applied<T>> {
    return this.exclusive(async () => {
      const view = await this.view();
      const result = write({ own: view.own, merged: view.list, now: this.now(), ...this.ids() });
      await this.publish(result.slice);
      return { value: result.value, view };
    });
  }

  /**
   * Re-publish our slice unchanged, so the envelope's recipient set is rebuilt from the
   * current roster — the shopping half of the app's `onRosterChanged`.
   *
   * Accepting a connection wraps the content key to them; revoking mints a fresh one and
   * does not, which rotates them out of everything published from here on.
   */
  async republish(): Promise<number> {
    return this.exclusive(async () => this.publish(await this.readOwn()));
  }

  // --- internals --------------------------------------------------------------------

  /**
   * This agent's own published slice, or an empty one if it has never published.
   *
   * Every other failure throws. Unlike the app's `pullShopping` there is no version gate:
   * the app has local rows to protect from an older remote, and here the remote *is* our
   * state, so the newest thing the server holds is by definition what we last wrote.
   */
  private async readOwn(): Promise<ShoppingListSnapshot> {
    const view = await this.ownSliceView();
    if (!view) return EMPTY_SNAPSHOT;
    const signature = view.envelope.signature;
    if (!signature || signature.by !== this.identity.uuid) {
      throw new ShoppingStoreError(
        'the list slice stored for this agent is not signed by it — refusing to overwrite it',
      );
    }
    if (
      !this.crypto.verify(
        SHOPPINGLIST_TYPE,
        this.ownSliceResourceId,
        view.envelope,
        this.identity.signPublicKey,
      )
    ) {
      throw new ShoppingStoreError(
        'the list slice stored for this agent fails its own signature — refusing to overwrite it',
      );
    }
    this.state.setLastVer(RESOURCE_SHOPPING, signature.ver);
    let plaintext: Uint8Array;
    try {
      plaintext = this.crypto.decrypt(
        view.envelope,
        this.identity.uuid,
        this.identity.encryptionKeyPair,
      );
    } catch (e) {
      throw new ShoppingStoreError(
        `this agent's own list slice will not open with this host's key — a different ` +
          `recovery phrase wrote it (${(e as Error).message})`,
        { cause: e },
      );
    }
    return decodeShoppingSnapshotBytes(plaintext);
  }

  private async ownSliceView(): Promise<{ ver: number; envelope: Envelope } | null> {
    const list = await this.api.getShoppingList(this.identity.uuid);
    const mine = list.slices.find((slice) => slice.authorUuid === this.identity.uuid);
    return mine ? { ver: mine.ver, envelope: mine.envelope } : null;
  }

  /**
   * Fetch, verify and decrypt one connection's slice, or say why not.
   *
   * Each author publishes into their **own** list, so a peer's slice is fetched from
   * their list id and carries the resource id `peer::peer` — the id they signed it
   * under. Verification is against the key **pinned in the roster**, never the server's
   * live answer: a server that swapped a peer's key could otherwise hand us a shopping
   * list it wrote itself.
   */
  private async readPeer(connection: Connection): Promise<AuthorSlice | UnreadableSource> {
    const refusal = (reason: UnreadableReason, detail: string): UnreadableSource => ({
      uuid: connection.uuid,
      displayName: connection.displayName,
      reason,
      detail,
    });

    let envelope: Envelope | undefined;
    try {
      const list = await this.api.getShoppingList(connection.uuid);
      envelope = list.slices.find((slice) => slice.authorUuid === connection.uuid)?.envelope;
    } catch (e) {
      return refusal('unreachable', `fetch failed: ${(e as Error).message}`);
    }
    if (!envelope) {
      return refusal('not_published', 'this account has not published a list slice yet');
    }
    const signature = envelope.signature;
    if (!signature || signature.by !== connection.uuid) {
      return refusal('not_verified', 'the stored slice is unsigned, or signed by someone else');
    }
    let signKey: Uint8Array;
    try {
      signKey = signingKeyOf(connection);
    } catch (e) {
      return refusal('not_verified', (e as Error).message);
    }
    const resourceId = `${connection.uuid}::${connection.uuid}`;
    if (!this.crypto.verify(SHOPPINGLIST_TYPE, resourceId, envelope, signKey)) {
      return refusal(
        'not_verified',
        'the slice does not verify against the key pinned for this connection',
      );
    }
    if (envelope.keys[this.identity.uuid] === undefined) {
      return refusal(
        'not_granted',
        'this account has not granted this agent its shopping list — the slice is published ' +
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
        `the wrapped key did not open the slice: ${(e as Error).message}`,
      );
    }
    try {
      return {
        authorUuid: connection.uuid,
        displayName: connection.displayName,
        connectionKind: connection.kind,
        snapshot: decodeShoppingSnapshotBytes(plaintext),
      };
    } catch (e) {
      return refusal('malformed', `the slice decrypted but did not parse: ${(e as Error).message}`);
    }
  }

  /**
   * Seal our slice to ourselves plus every connection granted the shopping list, and
   * PUT it.
   *
   * This is where the scope is *enforced*, and deliberately the only place. Filtering a
   * recipient list is the same act as not handing someone a key: a peer left out of the
   * wrap holds no key the ciphertext will open for, whatever any listing says.
   */
  private async publish(slice: ShoppingListSnapshot): Promise<number> {
    await this.deps.ensureRegistered?.();
    const recipients = [
      { uuid: this.identity.uuid, x25519PublicKey: this.identity.encPublicKey },
      ...this.roster
        .load()
        .connections.filter((c) => grants(c, 'shopping'))
        .map(toRecipient),
    ];
    return publishResource({
      crypto: this.crypto,
      identity: this.identity,
      state: this.state,
      resourceType: SHOPPINGLIST_TYPE,
      resourceId: this.ownSliceResourceId,
      storeKey: RESOURCE_SHOPPING,
      plaintext: encodeShoppingSnapshotBytes(slice),
      recipients,
      put: (envelope) =>
        this.api.putShoppingSlice(this.identity.uuid, this.identity.uuid, envelope),
      remoteVer: async () => (await this.ownSliceView())?.ver ?? 0,
    });
  }

  /**
   * Run `body` after every write already queued.
   *
   * Each write is a read-modify-write of our whole slice, so two in flight at once would
   * have the second overwrite the first with state read before it — and the server's
   * version check cannot catch that, because both writes are legitimately ours. MCP tool
   * calls arrive concurrently, so this is a real case, not a theoretical one.
   */
  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this.writes.then(body, body);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private ids(): { newId?: () => string } {
    return this.deps.newId ? { newId: this.deps.newId } : {};
  }
}

/** Injection seams: the clock, the id source, and the one-time user-row publish. */
export interface ShoppingServiceDeps {
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Publish this peer's user row if the server does not have it — the server resolves
   * our signing key from it to verify anything we write.
   */
  readonly ensureRegistered?: () => Promise<unknown>;
}

/** One read of the shared list. */
export interface ShoppingView {
  /** Our own slice — what a write is applied to. */
  readonly own: ShoppingListSnapshot;
  /** Every author's slice, merged: the list as the user sees it. */
  readonly list: MergedShoppingList;
  readonly unreadable: readonly UnreadableSource[];
  /**
   * How many accounts this agent is connected to. Zero is its own answer: nobody has
   * accepted this agent yet, which is a different thing from a connection that shared
   * nothing, and the caller has to be told which one it is looking at.
   */
  readonly connectionCount: number;
}

/** A write that landed, with the list it was applied to. */
export interface Applied<T> {
  readonly value: T;
  readonly view: ShoppingView;
}

/**
 * Why one connection's slice did not make it into the merge — the same vocabulary the
 * card view answers with, and deliberately the same type.
 */
export type { UnreadableReason, UnreadableSource };

/** Our own slice is unreadable, so no write can safely be built on it. */
export class ShoppingStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ShoppingStoreError';
  }
}
