/**
 * A loyalty card as this peer sees it — the port of `data/local/Card.kt` minus the
 * fields that only mean something on a phone.
 *
 * The app stores `frontImage` / `backImage` / `logoImage` as device-local file names;
 * they are meaningless here, so this model carries the {@link BlobPointer}s the
 * snapshot actually travels with instead. That is not a simplification: a card this
 * peer re-publishes must carry its photo pointers forward verbatim, or the next pull
 * on the user's phone reads a card whose photos vanished.
 */

import type { BlobPointer } from '../sync/blobPointer.js';

/**
 * The barcode symbologies the app reads and renders (`data/local/BarcodeFormat.kt`).
 *
 * These exact spellings are on the wire — the snapshot carries the enum *name* — so
 * entries may be added but never renamed.
 */
export const BARCODE_FORMATS = [
  'CODE_128',
  'EAN_13',
  'EAN_8',
  'UPC_A',
  'UPC_E',
  'CODE_39',
  'ITF',
  'QR_CODE',
] as const;

export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

/**
 * The format `name` spells, or `null` for anything else — absent, empty, misspelt, or
 * a symbology some future app version invented.
 *
 * Total on purpose, matching `BarcodeFormat.fromName`. A card whose format this
 * version cannot read is still a card: it keeps its title, notes and code, and only
 * loses the label saying how to draw the code.
 */
export function barcodeFormatFromName(name: string | null | undefined): BarcodeFormat | null {
  if (!name) return null;
  return BARCODE_FORMATS.find((f) => f === name) ?? null;
}

/** One loyalty card. `barcodeValue`/`barcodeFormat` are both null for a photo-only card. */
export interface Card {
  readonly id: string;
  readonly title: string;
  readonly notes: string | null;
  /** The decoded code payload; null for photo-only cards. */
  readonly barcodeValue: string | null;
  /** How to draw {@link barcodeValue}; null when there is no code, or an unreadable name. */
  readonly barcodeFormat: BarcodeFormat | null;
  /** Epoch millis the card was first saved. */
  readonly createdAt: number;
  /** Epoch millis of the most recent edit. */
  readonly updatedAt: number;
  /** Position in the grid; lower sorts first. */
  readonly sortOrder: number;
  /** Where the card's photos and logo live in the blob store, if the writer named them. */
  readonly photos: CardPhotos;
}

/**
 * The three image slots a card carries, as the snapshot states them.
 *
 * A slot has **three** states on the wire and this keeps all three (lc-mr9): a
 * pointer, an explicit `cleared` tombstone, or neither — "the writer cannot speak for
 * this slot". Collapsing the last two into "no photo" is how a re-publish silently
 * destroys someone's photos, so the distinction survives even though this peer never
 * sets a photo itself.
 */
export interface CardPhotos {
  readonly front: BlobPointer | null;
  readonly back: BlobPointer | null;
  readonly logo: BlobPointer | null;
  readonly frontCleared: boolean | null;
  readonly backCleared: boolean | null;
  readonly logoCleared: boolean | null;
}

/** The photo state of a card nobody has attached an image to. */
export const NO_PHOTOS: CardPhotos = {
  front: null,
  back: null,
  logo: null,
  frontCleared: null,
  backCleared: null,
  logoCleared: null,
};

/** True when this card names a photo in any of its three slots. */
export function hasAnyPhoto(photos: CardPhotos): boolean {
  return photos.front !== null || photos.back !== null || photos.logo !== null;
}
