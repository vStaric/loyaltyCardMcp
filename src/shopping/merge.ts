import { CONNECTION_KIND_PERSON, type ConnectionKind } from '../sharing/connectInvite.js';
import type { TodoItem, TodoSection } from './model.js';
import type { ShoppingListSnapshot } from './snapshot.js';

/**
 * The shared shopping list's merge — an OR-Set with per-item LWW. Port of
 * `sync/merge/ShoppingMerge.kt`.
 *
 * Each author only ever writes their **own** slice (`shoppinglist/{listId}::{author}`),
 * so the list is reconstructed by merging the slices every author published. This peer
 * is one more author in exactly that merge; nothing here is agent-specific.
 *
 * Every rule below is also stated language-neutrally in `test-vectors/shopping-merge.json`,
 * which the app runs too (`lcm-bgp`). Change a rule there in the same commit you change
 * it here — a rule the two implementations state differently is a shared list two devices
 * disagree about, and none of the four bugs cited below announced itself any louder.
 *
 * ## Items — OR-Set membership
 * Every add is a fresh row with a unique id and re-adding a name mints a new id, so an
 * id is added exactly once and removal is a **tombstone** (`clearedDate`), never an
 * in-place delete. Across slices the same id may be observed more than once — one
 * author adds it, another checks it — so per id we keep a single **representative**:
 * the observation with the greatest {@link contentStamp}, ties broken by the
 * lexicographically greatest author uuid for determinism. An id is live iff its
 * representative is not tombstoned.
 *
 * ## Item contents — per-item LWW
 * The representative carries the resolved row. Every write path that changes content
 * must move {@link contentStamp} or it cannot win — which is exactly how renames used
 * to be reverted (`lc-39d`).
 *
 * ## Where the row sits — a second, independent LWW
 * Placement (`sortOrder`, `indentLevel`) is resolved separately against
 * {@link layoutStamp}, and **only those two fields** are taken from the winner of it.
 * So an item is resolved from up to two observations, not one.
 *
 * The split is the point. A single stamp resolves a whole row, so whichever mutation
 * raises it drags that author's entire observation along — stale check-state and text
 * included. That is a fair price for text a user typed and can watch revert, but not
 * for a drag: a drag is cosmetic and rewrites every row of a section at once, so on one
 * stamp it would have carried a whole section's worth of stale check-states. Left
 * unstamped, though, a moved row ties with an untouched observation and loses on the
 * greater uuid — the drag simply sprang back (`lc-c3j`). Two comparators buy both.
 *
 * ## Sections
 * Unioned by id (representative = greatest `createdAt`, then greatest author uuid),
 * with the **title** resolved separately against {@link titleStamp} (`lc-l85`) and the
 * `deletedAt` tombstone **unioned** rather than raced (`lc-17q`). A section that is
 * both tombstoned and empty is dropped from the result entirely. Items whose section is
 * absent from every slice are dropped as orphans.
 */

/** Who contributed the winning observation of a merged item. */
export type ItemProvenance = OwnProvenance | SharedByProvenance;

/** The winning observation of this item is this peer's own. */
export interface OwnProvenance {
  readonly kind: 'own';
}

/** The winning observation came from a connected account. */
export interface SharedByProvenance {
  readonly kind: 'shared';
  readonly authorUuid: string;
  readonly displayName: string | null;
  /** Person or agent, from the roster label — carried so a badge can draw it. */
  readonly connectionKind: ConnectionKind;
}

/** The singleton `own` provenance; it carries no fields to distinguish. */
export const OWN: OwnProvenance = { kind: 'own' };

/** A merged item: the resolved row plus whose observation won. */
export interface MergedTodoItem {
  readonly item: TodoItem;
  readonly provenance: ItemProvenance;
}

/** A merged section and the items filed under it, in display order. */
export interface MergedTodoSection {
  readonly section: TodoSection;
  readonly items: readonly MergedTodoItem[];
}

/** The whole shared list after merging every author's slice. */
export interface MergedShoppingList {
  readonly sections: readonly MergedTodoSection[];
  /**
   * Every item id some author **other than this peer** published an observation of,
   * live or tombstoned — the ids a hard delete of our own row would leave something
   * behind to argue with (`lc-2wh`).
   *
   * It rides alongside {@link sections} because it answers a question provenance
   * cannot: provenance names the author whose observation *won*, while a removal has to
   * know whether anyone else *holds* one at all. The two part company the moment we act
   * on a peer's item — ours then wins and the item reads as `own` while the peer's copy
   * is still out there, exactly as live as it was.
   *
   * A tombstone of theirs is included on purpose: it cannot resurrect the item, so
   * tombstoning rather than deleting ours costs nothing.
   */
  readonly observedByPeers: ReadonlySet<string>;
}

/** One account's decrypted slice, tagged with whose it is. */
export interface AuthorSlice {
  readonly authorUuid: string;
  readonly displayName: string | null;
  readonly snapshot: ShoppingListSnapshot;
  /** The author's roster label; `person` for our own slice, which nobody labels. */
  readonly connectionKind?: ConnectionKind;
}

/** Active (non-tombstoned) items of a merged section, in display order. */
export function activeItems(section: MergedTodoSection): readonly MergedTodoItem[] {
  return section.items.filter((it) => it.item.clearedDate === null);
}

/**
 * True when the section is **gone**: some author removed it and nothing live is left in
 * it on any slice (`lc-17q`). {@link mergeShoppingSlices} drops these, so a removal one
 * author performed is a removal every author sees.
 *
 * Distinct from "has no active items", which is the far older and much weaker statement
 * that a section is empty right now: an emptied section is still a section and comes
 * back the moment anything is added to it.
 */
export function isRemoved(section: MergedTodoSection): boolean {
  return section.section.deletedAt !== null && activeItems(section).length === 0;
}

/**
 * Last-mutation timestamp of an item observation — the content comparator: the most
 * recent of its add, check, clear and content-mutation stamps.
 *
 * `stateChangedAt` carries every mutation the other three cannot express, and is not
 * redundant with them: *unchecking* nulls `checkedOffDate`, so without it the stamp
 * falls back to `addedDate` and moves BACKWARDS (`lc-99a`); a *text edit* moves no date
 * at all, so without it the edited row and an untouched observation of the same id are
 * identically stamped and the tie breaks on the greater uuid (`lc-39d`).
 *
 * `checkedOffDate` and `clearedDate` stay in the maximum so a slice written by a peer on
 * a build that predates the column still compares the way it always did.
 *
 * Moving a row is deliberately absent from this stamp; it has {@link layoutStamp}.
 */
export function contentStamp(item: TodoItem): number {
  return Math.max(
    item.addedDate,
    item.checkedOffDate ?? 0,
    item.clearedDate ?? 0,
    item.stateChangedAt ?? 0,
  );
}

/**
 * Last-placement timestamp: when this author last moved the row, by reorder
 * (`sortOrder`) or indent (`indentLevel`). The comparator for those two fields and
 * nothing else (`lc-c3j`).
 *
 * Unlike {@link contentStamp} it has no other dates to fall back on, and wants none: a
 * row is created by exactly one author and adopted verbatim by everyone else, so two
 * observations only disagree about placement once somebody has actually moved it. An
 * observation that reports no move stands at zero.
 */
export function layoutStamp(item: TodoItem): number {
  return item.layoutChangedAt ?? 0;
}

/**
 * Last-rename timestamp of a section observation: the comparator for its title and
 * nothing else (`lc-l85`). Deliberately not folded into the section representative's
 * `createdAt` — that would make a rename win the whole row, `sortOrder` included.
 */
export function titleStamp(section: TodoSection): number {
  return section.titleChangedAt ?? 0;
}

/** True when observation `(stamp, uuid)` outranks `(otherStamp, otherUuid)`. */
function beats(stamp: number, uuid: string, otherStamp: number, otherUuid: string): boolean {
  return stamp > otherStamp || (stamp === otherStamp && uuid > otherUuid);
}

interface Observed<T> {
  readonly value: T;
  readonly authorUuid: string;
}

/**
 * Merge `slices` into one list. `localUuid` identifies this peer's own slice so its
 * winning observations are tagged `own` — and so the uuid tiebreak is the fair
 * coin-flip it is meant to be, which it is not if a sentinel is passed instead of the
 * real account uuid (every character a uuid can hold sorts below `l` in `"local"`).
 */
export function mergeShoppingSlices(
  slices: readonly AuthorSlice[],
  localUuid: string,
): MergedShoppingList {
  // --- sections: union by id, representative = greatest (createdAt, authorUuid), the
  //     title resolved separately, the tombstone unioned across every author ---
  const sectionReps = new Map<string, Observed<TodoSection>>();
  const titleReps = new Map<string, Observed<TodoSection>>();
  const deletedAt = new Map<string, number>();
  for (const slice of slices) {
    for (const section of slice.snapshot.sections) {
      const prior = sectionReps.get(section.id);
      if (
        !prior ||
        beats(section.createdAt, slice.authorUuid, prior.value.createdAt, prior.authorUuid)
      ) {
        sectionReps.set(section.id, { value: section, authorUuid: slice.authorUuid });
      }
      const priorTitle = titleReps.get(section.id);
      if (
        !priorTitle ||
        beats(
          titleStamp(section),
          slice.authorUuid,
          titleStamp(priorTitle.value),
          priorTitle.authorUuid,
        )
      ) {
        titleReps.set(section.id, { value: section, authorUuid: slice.authorUuid });
      }
      // Not a comparator: a removal is a fact any author can state and none can retract,
      // so this is a union, not a race. The instant kept is the EARLIEST reported, which
      // is when the section was actually removed — a later author republishing the
      // tombstone (adoption copies the row verbatim) is repeating that removal, not
      // performing a new one.
      if (section.deletedAt !== null) {
        const seen = deletedAt.get(section.id);
        deletedAt.set(
          section.id,
          seen === undefined ? section.deletedAt : Math.min(seen, section.deletedAt),
        );
      }
    }
  }

  // --- items: union by id, representative = greatest (contentStamp, authorUuid), with
  //     placement resolved separately on (layoutStamp, authorUuid) ---
  const itemReps = new Map<string, Observed<TodoItem>>();
  const layoutReps = new Map<string, Observed<TodoItem>>();
  const observedByPeers = new Set<string>();
  for (const slice of slices) {
    // Recorded per slice, not per winner: this is "who HOLDS a row", which is exactly
    // what the LWW comparators throw away (lc-2wh).
    const isPeer = slice.authorUuid !== localUuid;
    for (const item of slice.snapshot.items) {
      if (isPeer) observedByPeers.add(item.id);
      const prior = itemReps.get(item.id);
      if (
        !prior ||
        beats(contentStamp(item), slice.authorUuid, contentStamp(prior.value), prior.authorUuid)
      ) {
        itemReps.set(item.id, { value: item, authorUuid: slice.authorUuid });
      }
      const priorLayout = layoutReps.get(item.id);
      if (
        !priorLayout ||
        beats(
          layoutStamp(item),
          slice.authorUuid,
          layoutStamp(priorLayout.value),
          priorLayout.authorUuid,
        )
      ) {
        layoutReps.set(item.id, { value: item, authorUuid: slice.authorUuid });
      }
    }
  }

  const authors = new Map(slices.map((slice) => [slice.authorUuid, slice]));

  // --- file items under their section (dropping orphans whose section nobody holds) ---
  // Placement is grafted on from its own winner: the content representative says what
  // the item IS, the layout representative says only where it sits. When nobody has
  // moved the row the two are the same observation and this is a no-op copy. Provenance
  // stays the content author's — a badge answers "whose item is this", which a drag does
  // not change.
  const bySection = new Map<string, MergedTodoItem[]>();
  for (const observation of itemReps.values()) {
    const { value, authorUuid } = observation;
    if (!sectionReps.has(value.sectionId)) continue;
    const placed = layoutReps.get(value.id)?.value ?? value;
    const item: TodoItem = {
      ...value,
      sortOrder: placed.sortOrder,
      indentLevel: placed.indentLevel,
    };
    const author = authors.get(authorUuid);
    const provenance: ItemProvenance =
      authorUuid === localUuid
        ? OWN
        : {
            kind: 'shared',
            authorUuid,
            displayName: author?.displayName ?? null,
            connectionKind: author?.connectionKind ?? CONNECTION_KIND_PERSON,
          };
    const list = bySection.get(item.sectionId);
    if (list) list.push({ item, provenance });
    else bySection.set(item.sectionId, [{ item, provenance }]);
  }

  // The title is grafted on from its own winner, exactly as an item's placement is, and
  // `titleChangedAt` travels WITH the title: adopting a section republishes it verbatim,
  // and a title paired with somebody else's stamp would be an observation this peer
  // never made. The tombstone comes from the union, so every author carries the same
  // removal regardless of which of them performed it.
  const sections = [...sectionReps.values()]
    .map(({ value }) => {
      const title = titleReps.get(value.id)?.value ?? value;
      const section: TodoSection = {
        ...value,
        title: title.title,
        titleChangedAt: title.titleChangedAt,
        deletedAt: deletedAt.get(value.id) ?? null,
      };
      return section;
    })
    .sort(compareSections)
    .map((section) => ({
      section,
      items: (bySection.get(section.id) ?? []).sort(compareItems),
    }))
    // Removed sections leave here rather than being left to each caller to filter: the
    // merged list is what every read and every write path sees, and a section one author
    // deleted is not on this list any more (lc-17q).
    .filter((merged) => !isRemoved(merged));

  return { sections, observedByPeers };
}

/** Display order of merged sections: slot, then age, then id to settle a shared slot. */
function compareSections(a: TodoSection, b: TodoSection): number {
  return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || compareStrings(a.id, b.id);
}

/**
 * Display order of merged items: slot first, id to settle a shared slot.
 *
 * Each author numbers their own rows densely from zero, so two authors who move a row at
 * once can land different ids on the same `sortOrder`. Falling back to the id keeps the
 * shared list in the SAME order on every device, which is what a shared list means.
 */
function compareItems(a: MergedTodoItem, b: MergedTodoItem): number {
  return a.item.sortOrder - b.item.sortOrder || compareStrings(a.item.id, b.item.id);
}

/**
 * Lexicographic by UTF-16 code unit, which is what the JVM's `String.compareTo` does —
 * the ordering the app's merge breaks its ties with. `localeCompare` would be a
 * different order on some hosts, and a tiebreak two implementations disagree about is a
 * shared list two devices disagree about.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
