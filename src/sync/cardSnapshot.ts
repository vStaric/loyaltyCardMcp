import { NO_PHOTOS, barcodeFormatFromName, type Card, type CardPhotos } from '../cards/card.js';
import { blobPointerFromJson, blobPointerToJson } from './blobPointer.js';
import { arr, asObject, int, intOr, optStr, parseJsonObject, str } from './json.js';

/**
 * The `cards` resource plaintext: the account's **whole** card list as one JSON blob,
 * which is what gets AEAD-encrypted into an envelope (`sync/Snapshots.kt`,
 * PRD-sync-sharing §6.1). A push fully replaces the prior version; a pull
 * reconstructs the list verbatim.
 *
 * ## Why this file is fussy about absent fields
 * The app encodes with `encodeDefaults = false` and `explicitNulls = false`, so a
 * field at its default — `v` when it is 1, an empty `cards`, every null — is simply
 * **not emitted**. Two things follow, and both are load-bearing:
 *
 * - Decoding must treat *absent* as the default, not as an error. A snapshot from the
 *   app legitimately arrives as `{"cards":[…]}` with no `v`.
 * - Encoding must omit them too. The photo tombstones are the reason it matters
 *   (lc-mr9): `frontBlobCleared` **absent** means "this writer cannot speak for the
 *   slot, keep the photo you have", while `false` would be a claim this peer has no
 *   business making. Emitting nulls everywhere would turn every silence into a
 *   statement.
 *
 * Image bytes are not in here. Photos go to the content-addressed blob store as their
 * own encrypted uploads and a card carries only the pointer that addresses one.
 */

/** The schema tag the app writes and this peer understands. */
export const CARDS_SNAPSHOT_SCHEMA = 1;

/** A decoded `cards` blob: the schema tag it declared, and the cards it held. */
export interface CardsSnapshot {
  readonly v: number;
  readonly cards: readonly Card[];
}

/**
 * Parse a `cards` blob. Throws {@link import('./json.js').DecodeError} if it is not
 * one — a caller holding a decrypted-but-unreadable snapshot must say so rather than
 * present an empty card list.
 *
 * A *newer* `v` is deliberately not rejected: the fields this version knows still
 * decode, and refusing the whole list because a later app added a column would hide
 * every card the user has. Unknown keys are ignored, matching `ignoreUnknownKeys`.
 */
export function decodeCardsSnapshot(text: string): CardsSnapshot {
  const o = parseJsonObject(text, 'cards');
  return {
    v: intOr(o, 'v', CARDS_SNAPSHOT_SCHEMA, 'cards'),
    cards: arr(o, 'cards', 'cards').map((raw, i) => cardFromJson(raw, `cards.cards[${i}]`)),
  };
}

/**
 * Serialize `cards` as the `cards` blob, dropping defaults and nulls the way the app
 * does. The bytes returned are what gets sealed.
 */
export function encodeCardsSnapshot(cards: readonly Card[]): string {
  const out: Record<string, unknown> = {};
  // `v` is at its default, so the app omits it and so do we — a snapshot that differs
  // from the app's only in the keys it spells out would be a needless divergence for
  // the shared vectors (lcm-bgp) to reconcile.
  if (cards.length > 0) out.cards = cards.map(cardToJson);
  return JSON.stringify(out);
}

function cardFromJson(raw: unknown, what: string): Card {
  const o = asObject(raw, what);
  return {
    id: str(o, 'id', what),
    title: str(o, 'title', what),
    notes: optStr(o, 'notes', what),
    barcodeValue: optStr(o, 'barcodeValue', what),
    barcodeFormat: barcodeFormatFromName(optStr(o, 'barcodeFormat', what)),
    createdAt: int(o, 'createdAt', what),
    updatedAt: int(o, 'updatedAt', what),
    sortOrder: int(o, 'sortOrder', what),
    photos: photosFromJson(o, what),
  };
}

function photosFromJson(o: Record<string, unknown>, what: string): CardPhotos {
  return {
    front: blobPointerFromJson(o.frontBlob, `${what}.frontBlob`),
    back: blobPointerFromJson(o.backBlob, `${what}.backBlob`),
    logo: blobPointerFromJson(o.logoBlob, `${what}.logoBlob`),
    frontCleared: clearedFlag(o.frontBlobCleared),
    backCleared: clearedFlag(o.backBlobCleared),
    logoCleared: clearedFlag(o.logoBlobCleared),
  };
}

/**
 * A photo tombstone: `true`, or `null` for "the writer did not say".
 *
 * Anything that is not the boolean `true` reads as "did not say", including a literal
 * `false` — the app never writes one, and the two mean the same thing, so there is
 * nothing to be gained by keeping a second spelling of silence alive.
 */
function clearedFlag(v: unknown): boolean | null {
  return v === true ? true : null;
}

/**
 * One card as snapshot JSON, in `CardSnapshot`'s **declaration order**.
 *
 * Order is not required for correctness — both sides read by name — but matching it
 * makes this encoder byte-identical to the app's for the same card, which is what
 * lets the shared merge vectors (lcm-bgp) compare bytes instead of re-parsing.
 */
function cardToJson(card: Card): Record<string, unknown> {
  const out: Record<string, unknown> = { id: card.id, title: card.title };
  if (card.notes !== null) out.notes = card.notes;
  if (card.barcodeValue !== null) out.barcodeValue = card.barcodeValue;
  if (card.barcodeFormat !== null) out.barcodeFormat = card.barcodeFormat;
  out.createdAt = card.createdAt;
  out.updatedAt = card.updatedAt;
  out.sortOrder = card.sortOrder;
  const photos = card.photos ?? NO_PHOTOS;
  if (photos.front) out.frontBlob = blobPointerToJson(photos.front);
  if (photos.back) out.backBlob = blobPointerToJson(photos.back);
  if (photos.logo) out.logoBlob = blobPointerToJson(photos.logo);
  if (photos.frontCleared === true) out.frontBlobCleared = true;
  if (photos.backCleared === true) out.backBlobCleared = true;
  if (photos.logoCleared === true) out.logoBlobCleared = true;
  return out;
}
