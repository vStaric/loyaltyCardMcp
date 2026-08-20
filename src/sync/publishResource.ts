import type { Envelope } from '../crypto/envelope.js';
import type { EnvelopeCrypto, Recipient } from '../crypto/envelopeCrypto.js';
import type { Identity } from '../crypto/identity.js';
import { StaleVersionError } from './apiError.js';
import type { SyncStateStore } from './syncState.js';

/** Bound on 409 reconcile retries before giving up — the app's `MAX_PUBLISH_ATTEMPTS`. */
export const MAX_PUBLISH_ATTEMPTS = 4;

export interface PublishRequest {
  readonly crypto: EnvelopeCrypto;
  readonly identity: Identity;
  readonly state: SyncStateStore;
  /** `"cards"` | `"shoppinglist"` | `"share"` — bound into the signature. */
  readonly resourceType: string;
  /** The signed resource id: the uuid, or `listId::authorUuid` for a list slice. */
  readonly resourceId: string;
  /** Key this resource's last-written version is remembered under. */
  readonly storeKey: string;
  readonly plaintext: Uint8Array;
  readonly recipients: readonly Recipient[];
  /** PUT the sealed envelope; returns the version the server stored. */
  readonly put: (envelope: Envelope) => Promise<number>;
  /** The server's current version for this resource, 0 if it has none — read on a 409. */
  readonly remoteVer: () => Promise<number>;
}

/**
 * Seal `plaintext` for `recipients` at `lastVer + 1` and publish it, retrying above the
 * server's current version on a `409 stale_version`. Returns the stored version, which
 * is also recorded locally. Port of `SyncEngine.publish`.
 *
 * ## Why a retry rather than a merge
 * The server enforces a strictly-monotonic `ver` per resource; a 409 means another
 * writer moved it. For the resources this peer owns — its own `cards` blob, its own
 * list slice, its own grant doc — "another writer" can only be another process holding
 * this same identity, so re-publishing above them is last-writer-wins on state we
 * already read. It is **not** a licence to clobber a peer: no peer can write here at
 * all, because the server would reject the signature.
 *
 * The caller must therefore have read the current state *before* building `plaintext`.
 * A caller that re-publishes a stale in-memory snapshot will win the CAS and lose the
 * other writer's edit, and no amount of retrying here would catch it.
 */
export async function publishResource(request: PublishRequest): Promise<number> {
  const { crypto, identity, state, resourceType, resourceId, storeKey } = request;
  let target = state.lastVer(storeKey) + 1;
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
    const envelope = crypto.seal(
      resourceType,
      resourceId,
      target,
      request.plaintext,
      request.recipients,
      identity.uuid,
      identity.signingKeyPair.secretKey,
    );
    try {
      const stored = await request.put(envelope);
      state.setLastVer(storeKey, stored);
      return stored;
    } catch (e) {
      if (!(e instanceof StaleVersionError)) throw e;
      const current = await request.remoteVer();
      state.setLastVer(storeKey, current);
      target = current + 1;
    }
  }
  throw new StaleVersionError(`exceeded reconcile retries for ${resourceType}/${resourceId}`);
}
