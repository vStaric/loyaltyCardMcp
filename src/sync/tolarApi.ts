import type { Envelope } from '../crypto/envelope.js';
import type {
  PairingCodeIssuedDto,
  PairingCodeResolvedDto,
  PairingPayloadDto,
  ShareRequestBody,
  ShareRequestsViewDto,
  ShareResponseViewDto,
  ShoppingListViewDto,
  UserProfileDto,
  UserPutBody,
} from './wire.js';

/**
 * Typed client for the zero-knowledge sync backend (`loyaltyCardBe`). One method per
 * endpoint in `PRD-sync-sharing.md` §6.2, grouped by resource. Port of `sync/TolarApi.kt`.
 *
 * An interface (not a concrete class) so callers depend on the operations and can be
 * tested against an in-memory fake; {@link HttpTolarApi} is the real fetch-based
 * implementation. Every call may reject with an
 * {@link import('./apiError.js').ApiError}.
 *
 * ## Signing responsibilities
 * - **Envelope writes** (`putCards`, `putShoppingSlice`, `putShare`,
 *   `putShareResponse`) authenticate through the signature *inside* the envelope —
 *   the caller seals it first.
 * - **Per-request signed** calls (`putUser`, `deleteUser`, `getRequestShare`,
 *   `getShareResponse`, `postPairingCode`, `putBlob`) are signed by this client's
 *   bound `RequestSigner`; the caller passes only the payload.
 * - **Public / permissionless** calls (`getUser`, `getCards`, `getShoppingList`,
 *   `getShare`, `getBlob`, `postRequestShare`, `postPairingResolve`) carry no signature.
 *
 * ## Deliberately absent
 * `PUT /api/device` and `POST /api/push` are the FCM push-token registry and its
 * fan-out. They exist to wake a phone that is not running; this peer is a process
 * that either runs or does not, has no FCM token to register, and polls when it is
 * up. Omitted because they are inapplicable here, not because they were overlooked.
 */
export interface TolarApi {
  // --- user ---------------------------------------------------------------------

  /** Public profile for `uuid`, or `null` if no such account exists (404). */
  getUser(uuid: string): Promise<UserProfileDto | null>;

  /**
   * Publish this peer's own user row at `uuid` targeting `ver` (per-request signed;
   * the first write is the TOFU key bind). Returns the stored version.
   */
  putUser(uuid: string, body: UserPutBody, ver: number): Promise<number>;

  /**
   * Permanently erase account `uuid` and everything the server holds keyed on it.
   * Per-request signed, because proving ownership of the account's signing key is the
   * only thing that authorises it.
   *
   * **Blobs are deliberately out of scope.** They are content-addressed, so two
   * accounts that uploaded the same photo share one row; erasing "your" blobs by
   * uploader would take out a row another account still references. Callers must not
   * describe this call as deleting the photo bytes.
   *
   * Idempotent: a 404 means the account is already gone, which is the outcome the
   * caller wanted, so it resolves rather than throwing.
   */
  deleteUser(uuid: string): Promise<void>;

  // --- cards --------------------------------------------------------------------

  /** The stored card envelope for `uuid`, or `null` if none has been published (404). */
  getCards(uuid: string): Promise<Envelope | null>;

  /** Publish the signed card `envelope` for `uuid`. Returns the stored version. */
  putCards(uuid: string, envelope: Envelope): Promise<number>;

  // --- shopping list ------------------------------------------------------------

  /** All authors' slices of the shared list `listId` (empty, never 404, if unwritten). */
  getShoppingList(listId: string): Promise<ShoppingListViewDto>;

  /**
   * Publish `authorUuid`'s own signed slice `envelope` of list `listId`. Returns the
   * stored version. The envelope's `resourceId` is `listId::authorUuid`.
   */
  putShoppingSlice(listId: string, authorUuid: string, envelope: Envelope): Promise<number>;

  // --- image blobs --------------------------------------------------------------

  /**
   * Upload one encrypted card photo under `hash`, the lowercase-hex SHA-256 of exactly
   * these `bytes` (per-request signed). The server recomputes and enforces that
   * address, stores the bytes verbatim, and cannot decrypt them.
   *
   * Idempotent by construction: identical content has the identical address. There is
   * no way to *ask* whether a blob exists — no HEAD, no listing.
   */
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;

  /**
   * Download the blob at `hash`, or `null` if the server has none (404) — an ordinary
   * state, not an error: the device that owns the photo may have pushed its card list
   * before its blobs.
   */
  getBlob(hash: string): Promise<Uint8Array | null>;

  // --- sharing ------------------------------------------------------------------

  /** Permissionless: ask `originUuid` to share with us. Returns the queued request id. */
  postRequestShare(originUuid: string, body: ShareRequestBody): Promise<number>;

  /** Origin-signed: list the pending inbound share requests addressed to `originUuid`. */
  getRequestShare(originUuid: string): Promise<ShareRequestsViewDto>;

  /**
   * Record this account's accept/decline decision on share request `requestId`. The
   * `envelope` carries the decision sealed to the requester and is signed over the
   * request id, so it self-authenticates and cannot be replayed onto another request.
   *
   * The decision table is append-only: the first response for a request stands. A
   * byte-identical repeat is accepted as the retry it is, but a *different* answer is
   * refused with a 409 ({@link import('./apiError.js').StaleVersionError}).
   */
  putShareResponse(requestId: number, envelope: Envelope): Promise<number>;

  /**
   * Read the answer to share request `requestId`, which only its requester may do
   * (per-request signed). `null` if the server has no such request (404).
   *
   * An unanswered request is **not** a 404 and **not** a decline: it comes back as
   * `SHARE_RESPONSE_PENDING`, which is how "they have not looked" stays
   * distinguishable from "they said no".
   */
  getShareResponse(requestId: number): Promise<ShareResponseViewDto | null>;

  // --- short pairing code -------------------------------------------------------

  /**
   * Mint a short pairing code standing in for `body` (per-request signed, so the
   * server can bind the code to this account). Returns the code and its expiry — the
   * one and only time the code crosses the wire in this direction.
   */
  postPairingCode(body: PairingPayloadDto): Promise<PairingCodeIssuedDto>;

  /**
   * Permissionless: exchange a short `code` for the payload it stands for, spending
   * one of its uses. `null` when the server will not resolve it (404).
   *
   * That `null` deliberately covers **unknown, expired and already-used alike** — the
   * server answers all three identically so a guesser cannot learn that a code
   * existed. Callers must not claim to know which of the three happened.
   */
  postPairingResolve(code: string): Promise<PairingCodeResolvedDto | null>;

  // --- share / roster -----------------------------------------------------------

  /** The stored share/roster envelope for `uuid`, or `null` if none exists (404). */
  getShare(uuid: string): Promise<Envelope | null>;

  /** Publish the signed share/roster `envelope` for `uuid`. Returns the stored version. */
  putShare(uuid: string, envelope: Envelope): Promise<number>;
}
