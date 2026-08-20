import { imageBlobAddress, openImageBlob } from '../images/imageBlob.js';
import { sniffImageMediaType } from '../images/mediaType.js';
import type { MergedCard } from '../merge/cardMerge.js';
import type { TolarApi } from '../sync/tolarApi.js';
import type { CardPhotos } from './card.js';
import type { CardService, CardsView } from './cardService.js';

/**
 * Reading the photo bytes of a card this agent can see (PRD-agent-connection §4.2:
 * "read every shared card … title, notes, barcode value and format, **photos**").
 *
 * A card names its photos as `BlobPointer`s — a content address plus the key
 * that opens it — and the bytes live in the server's blob store, encrypted under that
 * key in the app's `ImageCipher` format. Fetching one is therefore three steps and a
 * check: GET the address, confirm the bytes *are* that address, open them, and work
 * out what kind of image came out.
 *
 * ## This grants nothing new
 * The key rides inside the card snapshot, which is sealed to the recipients of the
 * cards resource. A photo is readable exactly when the card naming it is, so a
 * connection that withheld the cards scope withholds its photos by the same act. There
 * is no second permission here to get wrong.
 *
 * ## Read-only, deliberately
 * There is no `write` half. This peer has no camera, and the {@link CardService}
 * carries an author's pointers through a re-publish verbatim rather than re-encrypting
 * anything — so the only image code this peer needs is the code that opens.
 */
export class CardPhotoService {
  constructor(
    private readonly cards: CardService,
    private readonly api: TolarApi,
    private readonly deps: CardPhotoDeps = {},
  ) {}

  /**
   * The bytes of one card's photo, or the reason there are none to hand back.
   *
   * The misses are results rather than thrown errors because each is an ordinary state
   * of a healthy account: no photo in that slot, or a photo whose owner has published
   * the card but not yet pushed the blob. What *does* throw is an integrity failure —
   * bytes that are not at the address they were fetched from, or that the card's own
   * key will not open — because nothing the caller does next should treat those as
   * "no photo".
   */
  async read(cardId: string, slot: PhotoSlot): Promise<PhotoRead> {
    const { view, card } = await this.cards.get(cardId);
    if (!card) {
      return {
        available: false,
        reason: 'no_such_card',
        detail: `no card with id ${cardId} is visible to this agent`,
        card: null,
        view,
      };
    }
    const miss = (reason: PhotoMissReason, detail: string): PhotoRead => ({
      available: false,
      reason,
      detail,
      card,
      view,
    });

    const pointer = card.card.photos[slot];
    if (!pointer) {
      return miss('no_photo', slotSilence(card.card.photos, slot));
    }

    const bytes = await this.api.getBlob(pointer.hash);
    if (!bytes) {
      // Not an error and not an empty slot: the card says there is a photo, and the
      // device that owns it has published the card list ahead of the blob. Saying "no
      // photo" here would contradict the card the same call just read.
      return miss(
        'not_stored',
        'the card names this photo but the server does not hold it yet — the device that ' +
          'owns it published the card before the image finished uploading. It usually ' +
          'appears within a sync pass or two.',
      );
    }
    const cap = this.maxBytes();
    if (bytes.length > cap) {
      return miss(
        'too_large',
        `the photo is ${bytes.length} bytes, over this server's ${cap}-byte ceiling for ` +
          `returning image bytes to a model. Raise it with ${ENV_MAX_PHOTO_BYTES} if the ` +
          'host can carry it.',
      );
    }

    // The server enforces this address on upload, so a mismatch means the bytes were
    // swapped in transit or in the store. The tag below would catch it too, as a
    // decryption failure — which would read as "the owner's key is wrong" and send the
    // caller after the wrong fault.
    const address = imageBlobAddress(bytes);
    if (address !== pointer.hash) {
      throw new CardPhotoError(
        `the blob served for ${cardId}'s ${slot} photo is not the one the card names: ` +
          `asked for ${pointer.hash}, got bytes that address as ${address}`,
      );
    }

    let plain: Uint8Array;
    try {
      plain = openImageBlob(bytes, pointer.key);
    } catch (e) {
      throw new CardPhotoError(
        `${cardId}'s ${slot} photo did not open with the key in the card: ${(e as Error).message}`,
        { cause: e },
      );
    }
    return {
      available: true,
      card,
      photo: {
        cardId,
        slot,
        bytes: plain,
        mediaType: sniffImageMediaType(plain),
        hash: pointer.hash,
      },
    };
  }

  private maxBytes(): number {
    return this.deps.maxBytes ?? DEFAULT_MAX_PHOTO_BYTES;
  }
}

/** Injection seam: the size ceiling, so a host can budget its own context. */
export interface CardPhotoDeps {
  readonly maxBytes?: number;
}

/** The three image slots a card carries. */
export const PHOTO_SLOTS = ['front', 'back', 'logo'] as const;

export type PhotoSlot = (typeof PHOTO_SLOTS)[number];

/** The slot `name` spells, or `null` for anything else. */
export function photoSlotFromName(name: string | null | undefined): PhotoSlot | null {
  if (!name) return null;
  return PHOTO_SLOTS.find((s) => s === name) ?? null;
}

/** One card photo, decrypted. */
export interface CardPhoto {
  readonly cardId: string;
  readonly slot: PhotoSlot;
  /** The decrypted image, exactly as its author's device stored it. */
  readonly bytes: Uint8Array;
  /** Sniffed from the bytes; `null` when they are not a format this version knows. */
  readonly mediaType: string | null;
  /** The blob's content address — the same string the card's pointer carries. */
  readonly hash: string;
}

/** Why there are no bytes to return. Every one of these is an ordinary state. */
export type PhotoMissReason =
  /** No card with that id is visible to this agent at all. */
  | 'no_such_card'
  /** The card is visible and names no photo in that slot. */
  | 'no_photo'
  /** The card names a photo the blob store does not hold yet. */
  | 'not_stored'
  /** The blob is larger than this server will hand back. */
  | 'too_large';

/** A photo read: the bytes, or the reason for their absence, always with the card. */
export type PhotoRead =
  | { readonly available: true; readonly photo: CardPhoto; readonly card: MergedCard }
  | {
      readonly available: false;
      readonly reason: PhotoMissReason;
      readonly detail: string;
      /** The card the miss is about, or `null` when no such card is visible. */
      readonly card: MergedCard | null;
      /** The view it was read from, so a caller can name what it could not read. */
      readonly view: CardsView;
    };

/** A photo that should have opened and did not. An integrity failure, not an absence. */
export class CardPhotoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CardPhotoError';
  }
}

/**
 * The largest blob this server will decrypt and hand back, in bytes.
 *
 * 2 MiB is the backend's own per-blob ceiling (`BlobConfig.DEFAULT_MAX_BYTES`), which
 * makes it the only cap that refuses nothing a phone was allowed to upload. A tighter
 * default would report an ordinary card photo as "too large", which a user reads as a
 * fault in their own data rather than as this server's budget.
 *
 * The cost is real and belongs to the host, not to the card: 2 MiB of image is ~2.7 MB
 * of base64 in a tool result, which a host that renders image content pays for in image
 * tokens and a host that does not pays for in text. So it is a *configured* ceiling —
 * {@link ENV_MAX_PHOTO_BYTES} lowers it — and the refusal names the variable, so a
 * model that hits it can tell the user which knob is theirs to turn.
 */
export const DEFAULT_MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export const ENV_MAX_PHOTO_BYTES = 'TOLAR_MCP_MAX_PHOTO_BYTES';

/**
 * The configured ceiling, or the default when the variable is unset.
 *
 * A value that is not a positive integer throws rather than falling back. Silently
 * ignoring it would leave an operator who meant to cap photos at 200 KB serving 2 MiB
 * ones and believing otherwise.
 */
export function maxPhotoBytesFrom(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_MAX_PHOTO_BYTES]?.trim();
  if (!raw) return DEFAULT_MAX_PHOTO_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${ENV_MAX_PHOTO_BYTES} must be a positive whole number of bytes: ${raw}`);
  }
  return parsed;
}

/**
 * What an empty slot means, in the three states the wire can say it (lc-mr9).
 *
 * "The author cleared this photo" and "the author's app never spoke for this slot" are
 * different facts, and a card merged from an older writer legitimately shows the
 * second. Reporting both as a flat "no photo" would be true but would throw away the
 * only evidence a caller has that a photo it saw yesterday was deliberately removed.
 */
function slotSilence(photos: CardPhotos, slot: PhotoSlot): string {
  const cleared = photos[`${slot}Cleared` as const];
  return cleared === true
    ? `this card's ${slot} photo was removed by its author`
    : `this card has no ${slot} photo`;
}
