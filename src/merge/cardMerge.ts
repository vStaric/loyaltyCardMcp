import type { Card } from '../cards/card.js';
import type { ConnectionKind } from '../sharing/connectInvite.js';

/**
 * Where a card came from — port of `sync/merge/CardMerge.kt`'s `CardProvenance`.
 *
 * This peer's seat is the interesting difference. In the app, `Own` is the user's own
 * grid and `SharedBy` is everyone else. Here, `own` is what the **agent** authored and
 * the user's cards arrive as `sharedBy` — so a tool result that says `own` is saying
 * "this agent put this here", which is exactly the attribution §7.4 makes
 * non-negotiable. Nothing an agent writes may be reported as if it were the user's.
 */
export type CardProvenance =
  | { readonly kind: 'own' }
  | {
      readonly kind: 'sharedBy';
      readonly authorUuid: string;
      readonly displayName: string | null;
      /** The roster label the operator confirmed — a label, never an access control. */
      readonly connectionKind: ConnectionKind;
    };

/** A card as it appears in the merged grid: the card plus where it came from. */
export interface MergedCard {
  readonly card: Card;
  readonly provenance: CardProvenance;
}

/** One connected account's decrypted card list, tagged with whose it is. */
export interface SharedCards {
  readonly authorUuid: string;
  readonly displayName: string | null;
  readonly kind: ConnectionKind;
  readonly cards: readonly Card[];
}

/**
 * Merge this peer's own cards with cards shared by connected accounts into one view,
 * **deduplicated by card code** (PRD-sync-sharing §7.6). A read-only union: nothing
 * here writes, and there is no per-field merge to get wrong — `cards/{uuid}` is a
 * single blob owned and signed by one author, which is the whole reason an agent can
 * add a card but never edit the user's (PRD-agent-connection §4.2, §6).
 *
 * ## Dedup rule (format-aware)
 * Two cards are the same code iff they carry the **same `barcodeValue` AND the same
 * `barcodeFormat`** — the same digits under different symbologies are different cards.
 * A photo-only card (null `barcodeValue`) carries no code and is therefore never a
 * duplicate: every one is kept.
 *
 * ## Precedence
 * Own cards are emitted first and seed the seen-set, so a card we also hold never
 * shows as somebody else's. Among multiple sharers holding one code, the
 * lowest-sorting `authorUuid` wins — a stable, content-independent tiebreak, so the
 * result does not depend on the order the peers were fetched in.
 */
export function mergeCards(
  own: readonly Card[],
  shared: readonly SharedCards[],
): readonly MergedCard[] {
  const seen = new Set<string>();
  const merged: MergedCard[] = [];

  for (const card of own) {
    const key = codeKey(card);
    if (key !== null) seen.add(key);
    merged.push({ card, provenance: { kind: 'own' } });
  }

  for (const set of [...shared].sort(byAuthorUuid)) {
    const provenance: CardProvenance = {
      kind: 'sharedBy',
      authorUuid: set.authorUuid,
      displayName: set.displayName,
      connectionKind: set.kind,
    };
    for (const card of set.cards) {
      const key = codeKey(card);
      // Codeless cards always survive; coded cards only if unseen.
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push({ card, provenance });
    }
  }
  return merged;
}

/**
 * A format-aware code identity, or `null` for a photo-only (codeless) card.
 *
 * The value is **length-prefixed** so the two halves cannot be confused for one
 * another: without it, the codeless card `"12 EAN_8"` and the `EAN_8` card `"12"` would
 * build the same key and the merge would drop one of two genuinely different cards.
 */
function codeKey(card: Card): string | null {
  if (card.barcodeValue === null) return null;
  return `${card.barcodeValue.length}:${card.barcodeValue}:${card.barcodeFormat ?? ''}`;
}

function byAuthorUuid(a: SharedCards, b: SharedCards): number {
  return a.authorUuid < b.authorUuid ? -1 : a.authorUuid > b.authorUuid ? 1 : 0;
}
