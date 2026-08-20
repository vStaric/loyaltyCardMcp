import { randomUUID } from 'node:crypto';
import {
  activeItems,
  type MergedShoppingList,
  type MergedTodoItem,
  type MergedTodoSection,
} from './merge.js';
import { clampIndent, type TodoItem, type TodoSection } from './model.js';
import type { ShoppingListSnapshot } from './snapshot.js';

/**
 * Every write this peer can make to the shared shopping list, as pure functions from
 * (our slice, the merged list, a clock) to a **new slice**.
 *
 * Ported from `data/TodoRepositoryImpl.kt`, `data/local/TodoDao.kt`,
 * `data/TodoReorder.kt` and `ui/screens/SharedTodoWrites.kt` — four files in the app,
 * one here, because the thing they collectively encode is one thing: **which stamp a
 * write moves**.
 *
 * ## The stamp column is the whole risk
 * Each rule below is a bug the Android app already shipped and fixed. A second
 * implementation gets to re-live all of them, because none of them fails loudly — the
 * write succeeds, the tool reports success, and the user's phone silently reverts it on
 * the next merge:
 *
 * | write | stamp it must move | what happens without it |
 * |---|---|---|
 * | add item | `addedDate` | — |
 * | rename / footnote | `stateChangedAt` | ties with a peer's stale observation, loses on the uuid tiebreak, the typing is reverted (`lc-39d`) |
 * | check | `checkedOffDate` + `stateChangedAt` | — |
 * | uncheck | `stateChangedAt` | the stamp moves BACKWARDS and the uncheck snaps back (`lc-99a`) |
 * | reorder / indent | `layoutChangedAt`, and **never** `stateChangedAt` | on the content stamp, one move drags a whole section's stale check-states with it (`lc-c3j`) |
 * | rename section | `titleChangedAt`, and **never** the section representative | the same, for the section's `sortOrder` (`lc-l85`) |
 * | remove item | `clearedDate` **and** `stateChangedAt`, never a row delete | a delete leaves the peer's live observation unopposed and the item returns next merge |
 *
 * ## Adoption
 * Two further constraints, both from the app:
 * - **Write the section alongside the item** (`lc-ing`). An item can only exist under a
 *   section row the writer holds, so adding into a peer's section adopts it first.
 * - **Observe a peer's item under the peer's own id** (`lc-99a`). An observation is a
 *   second opinion about an existing element, so it must collide with the peer's row in
 *   the merge's union-by-id and compete with it in the tiebreak. Minting a fresh id
 *   instead — the tempting "copy their item into my list" — forks one item into two rows
 *   that both stay live and can never be reconciled.
 *
 * ## Why pure functions over a slice
 * The app's repository writes rows to Room and the sync engine publishes what it finds.
 * This peer has no local database: its slice *is* the published resource, so a write is
 * a slice-to-slice function and the sync layer ({@link import('./shoppingSync.js')})
 * does the fetch-merge-publish around it. That also makes every rule above testable
 * against a fixed clock, with no network and no crypto in the way.
 */

/** Why a write could not be made. Carries a code so a tool can answer precisely. */
export class ShoppingWriteError extends Error {
  constructor(
    readonly code: 'no_such_item' | 'no_such_section' | 'invalid_argument',
    message: string,
  ) {
    super(message);
    this.name = 'ShoppingWriteError';
  }
}

/** What every write reads: our own slice, the merged list, and the wall clock. */
export interface WriteContext {
  /** This peer's own slice — the only resource it can publish. */
  readonly own: ShoppingListSnapshot;
  /** Our slice merged with every connected peer's: the list as the user sees it. */
  readonly merged: MergedShoppingList;
  /** Epoch millis stamped on this write. Injected so the rules are testable. */
  readonly now: number;
  /** Mints ids for new rows; injected for the same reason. */
  readonly newId?: () => string;
}

/** A completed write: the slice to publish, and what it did, for the tool's answer. */
export interface WriteResult<T> {
  readonly slice: ShoppingListSnapshot;
  readonly value: T;
}

// --- section writes --------------------------------------------------------------

/**
 * Create a section, appended past the foot of the list **as the merged view has it**.
 *
 * The slot is `max(ours, merged) + 1` for the reason `lc-bif` gives on the item side:
 * our own rows are not the list on screen, and numbering a new section off our own max
 * alone lands it on top of a peer's.
 */
export function createSection(ctx: WriteContext, title: string): WriteResult<TodoSection> {
  const trimmed = title.trim();
  if (!trimmed) throw new ShoppingWriteError('invalid_argument', 'a section needs a title');
  const section: TodoSection = {
    id: (ctx.newId ?? randomUUID)(),
    title: trimmed,
    createdAt: ctx.now,
    titleChangedAt: null,
    deletedAt: null,
    sortOrder: nextSectionSlot(ctx),
  };
  return { slice: upsertSection(ctx.own, section), value: section };
}

/**
 * Rename a section, stamping `titleChangedAt` — and **only** that (`lc-l85`).
 *
 * Folding the rename into the section representative (`createdAt`) would make it win the
 * whole row, carrying this author's `sortOrder` onto everyone else's list; leaving it
 * unstamped ties with an untouched observation, which loses on the greater uuid and
 * silently reverts the title.
 *
 * **Adopts as it writes.** A section only a peer holds has no row of ours to update, so
 * the renamed row is inserted rather than the write matching nothing. Inserting the
 * renamed row is the same end state as adopting verbatim and then updating, minus a
 * write.
 */
export function renameSection(
  ctx: WriteContext,
  sectionId: string,
  title: string,
): WriteResult<TodoSection> {
  const trimmed = title.trim();
  if (!trimmed) throw new ShoppingWriteError('invalid_argument', 'a section needs a title');
  const current = requireSection(ctx, sectionId).section;
  const renamed: TodoSection = { ...current, title: trimmed, titleChangedAt: ctx.now };
  return { slice: upsertSection(ctx.own, renamed), value: renamed };
}

// --- item writes -----------------------------------------------------------------

/** One item an add is about to write: a name, and the indent it was asked for. */
export interface NewItem {
  readonly name: string;
  readonly indentLevel?: number;
}

/**
 * Add items to a section, in order, at the foot of the list **as the merged view has
 * it** (`lc-bif`).
 *
 * Blank names are skipped; a batch of nothing but blanks writes nothing at all, and in
 * particular does not adopt the section — an abandoned add must not leave a peer's
 * section republished in our slice as a side effect of having been looked at.
 *
 * `stateChangedAt` is deliberately left null. An add moves `addedDate`, which is already
 * in the content comparator, and a fresh id has nothing to compete with anyway.
 */
export function addItems(
  ctx: WriteContext,
  sectionId: string,
  items: readonly NewItem[],
): WriteResult<readonly TodoItem[]> {
  const section = requireSection(ctx, sectionId);
  const pending = items
    .map((item) => ({ ...item, name: item.name.trim() }))
    .filter((item) => item.name.length > 0);
  if (pending.length === 0) return { slice: ctx.own, value: [] };

  // The section is adopted before the items are written (lc-ing): an item can only exist
  // under a section row this author holds, and on a shared list we hold a peer's section
  // only once we have acted inside it.
  let slice = adoptSection(ctx.own, section.section);
  let slot = nextItemSlot(ctx, section);
  const stored: TodoItem[] = [];
  for (const item of pending) {
    const row: TodoItem = {
      id: (ctx.newId ?? randomUUID)(),
      sectionId: section.section.id,
      name: item.name,
      addedDate: ctx.now,
      checkedOffDate: null,
      clearedDate: null,
      stateChangedAt: null,
      layoutChangedAt: null,
      sortOrder: slot++,
      footnote: null,
      footnoteSub: null,
      indentLevel: clampIndent(item.indentLevel ?? 0),
    };
    stored.push(row);
    slice = upsertItem(slice, row);
  }
  return { slice, value: stored };
}

/**
 * Rename an item, stamping `stateChangedAt` (`lc-39d`).
 *
 * A rename moves no other date, so an unstamped one is byte-identically stamped with a
 * peer's untouched observation of the same id — the tie breaks on the greater uuid, and
 * roughly half the time the peer's stale text overwrites what was just typed.
 */
export function renameItem(ctx: WriteContext, itemId: string, name: string): WriteResult<TodoItem> {
  const trimmed = name.trim();
  if (!trimmed) throw new ShoppingWriteError('invalid_argument', 'an item needs a name');
  return contentWrite(ctx, itemId, (item) => ({ ...item, name: trimmed }));
}

/**
 * Check or uncheck an item: `checkedOffDate` moves to now (or back to null), and
 * `stateChangedAt` is stamped on **both** (`lc-99a`).
 *
 * Nulling `checkedOffDate` cannot be the only record of an uncheck: it LOWERS the row's
 * content stamp, so the peer who checked it keeps winning and the uncheck visibly snaps
 * back on the next merge.
 */
export function setChecked(
  ctx: WriteContext,
  itemId: string,
  checked: boolean,
): WriteResult<TodoItem> {
  return contentWrite(ctx, itemId, (item) => ({
    ...item,
    checkedOffDate: checked ? ctx.now : null,
  }));
}

/**
 * Pin, edit, or — with a null `text` — unpin an item's footnote, stamping
 * `stateChangedAt`: a note is text, and text moves no other date (`lc-39d`).
 *
 * Only null unpins. An **empty string** is a real state — a note that has been created
 * but not yet written — so it is stored as written. Unpinning also drops the note's own
 * footnote: a footnote-of-a-footnote with no parent has nothing to hang off, and leaving
 * it behind would resurrect it the next time the item is footnoted.
 *
 * `sub` is ignored while the item carries no footnote, matching the app's guarded
 * `UPDATE … WHERE footnote IS NOT NULL` — and, as there, a write the guard rejects
 * stamps nothing, having changed nothing.
 */
export function setFootnote(
  ctx: WriteContext,
  itemId: string,
  text: string | null,
  sub?: string | null,
): WriteResult<TodoItem> {
  return contentWrite(ctx, itemId, (item) => {
    const footnote = text === null ? null : text.trim();
    if (footnote === null) return { ...item, footnote: null, footnoteSub: null };
    const footnoteSub = sub === undefined ? item.footnoteSub : sub === null ? null : sub.trim();
    return { ...item, footnote, footnoteSub };
  });
}

/**
 * Remove an item — a **tombstone**, never a row delete.
 *
 * Deleting our row would drop the only thing arguing for the removal, so a peer's live
 * observation wins the next merge and the item comes back: the removal looks like it
 * worked until the list refreshes. An OR-Set element leaves by tombstone.
 *
 * Both `clearedDate` and `stateChangedAt` are stamped, matching `TodoDao.setItemCleared`
 * — the app writes both in one statement, and the second is what makes the tombstone
 * outrank an observation somebody checked at the same millisecond.
 *
 * This peer always tombstones, including for an item nobody else holds, where the app
 * would hard-delete its own row. The two are equivalent on a list this peer shares (the
 * tombstone is exactly as gone) and the tombstone is the only one of the two that is
 * *always* right — the cheaper case is not worth a second rule that can be applied to
 * the wrong item.
 */
export function removeItem(ctx: WriteContext, itemId: string): WriteResult<TodoItem> {
  return contentWrite(ctx, itemId, (item) => ({ ...item, clearedDate: ctx.now }));
}

/**
 * Move an item within its section and/or change its indent — the placement write, and
 * the only one that stamps `layoutChangedAt` (`lc-c3j`).
 *
 * `toIndex` is a position in the section's **active merged order**, which is the only
 * order the user can see; it is clamped into range. Passing neither `toIndex` nor
 * `indentLevel` is a no-op that still costs a publish, so it is refused instead.
 *
 * ## One row is written, and why not the whole section
 * The app renumbers a dragged section densely from zero (`TodoReorder.resortedItems`) —
 * over **its own** rows, because those are the ones it holds. That is right for a list
 * whose rows are mostly the user's own and wrong for this peer, which typically holds one
 * row in a section full of somebody else's: renumbering our single row to a dense
 * position lands it on a slot a peer's row already occupies, and the merge's id tiebreak
 * then puts it on whichever side of that row the ids happen to fall.
 *
 * Adopting the peer's rows in order to renumber them is not the way out. A verbatim copy
 * of a peer's row carries an *identical* content stamp, so the content tiebreak falls to
 * the greater uuid — and where that is ours, reordering a section would silently
 * re-attribute every item in it to the agent. The user's own milk would start showing as
 * the assistant's.
 *
 * So this writes exactly one row, and picks its `sortOrder` **relative to the merged
 * neighbours it must land between** rather than from a dense renumbering. Slots are
 * integers and nothing requires them to start at zero or to be contiguous, so there is
 * room on both sides of the list and, in the usual case, between any two rows. The three
 * cases:
 *
 * - **an end** — one below the first slot, or one above the last;
 * - **a gap** — any integer strictly between the two neighbours;
 * - **adjacent slots** — no integer fits, so the id tiebreak is used deliberately: share
 *   the neighbour's slot on whichever side the item's own id sorts correctly.
 *
 * Only when neither side's id works does the row land one place off, which needs both
 * adjacent slots *and* an id ordering that fights the move. The app self-heals it: the
 * next drag the user makes in that section renumbers it densely again.
 */
export function moveItem(
  ctx: WriteContext,
  itemId: string,
  placement: { readonly toIndex?: number; readonly indentLevel?: number },
): WriteResult<TodoItem> {
  if (placement.toIndex === undefined && placement.indentLevel === undefined) {
    throw new ShoppingWriteError('invalid_argument', 'a move needs a toIndex or an indentLevel');
  }
  const found = requireItem(ctx, itemId);
  const section = found.section;

  // Adopt first: the write lands on a row of ours, and on a shared list the row being
  // moved may exist only on a peer's slice.
  let moved: TodoItem =
    placement.indentLevel === undefined
      ? found.item.item
      : { ...found.item.item, indentLevel: clampIndent(placement.indentLevel) };
  if (placement.toIndex !== undefined) {
    moved = { ...moved, sortOrder: slotFor(section, itemId, placement.toIndex) };
  }
  const slice = upsertItem(adoptSection(ctx.own, section.section), {
    ...moved,
    layoutChangedAt: ctx.now,
  });
  return { slice, value: sliceItem(slice, itemId) };
}

/**
 * The `sortOrder` that lands `itemId` at `toIndex` of its section's active merged order.
 * See {@link moveItem} for why this is neighbour arithmetic rather than a renumbering.
 */
function slotFor(section: MergedTodoSection, itemId: string, toIndex: number): number {
  const others = activeItems(section)
    .map((entry) => entry.item)
    .filter((row) => row.id !== itemId);
  const at = clampIndex(toIndex, others.length + 1);
  const before = others[at - 1];
  const after = others[at];
  if (!before && !after) return 0;
  if (!before) return after!.sortOrder - 1;
  if (!after) return before.sortOrder + 1;
  if (after.sortOrder - before.sortOrder >= 2) return before.sortOrder + 1;
  // Adjacent (or equal) slots: no integer fits between them, so land on a neighbour's
  // slot and let the merge's id tiebreak place the row on the correct side of it.
  if (itemId > before.id) return before.sortOrder;
  if (itemId < after.id) return after.sortOrder;
  return before.sortOrder;
}

// --- the shared shape of a content write ------------------------------------------

/**
 * Adopt the item (and its section) into our slice, apply `change`, and stamp
 * `stateChangedAt` — the shape every content write has.
 *
 * The base is the **merged** row, not ours: that is the row the user is looking at, and
 * it is what the app's screens pass into the repository. When our observation is already
 * the winning one the two are the same row.
 */
function contentWrite(
  ctx: WriteContext,
  itemId: string,
  change: (item: TodoItem) => TodoItem,
): WriteResult<TodoItem> {
  const found = requireItem(ctx, itemId);
  const written: TodoItem = { ...change(found.item.item), stateChangedAt: ctx.now };
  const slice = upsertItem(adoptSection(ctx.own, found.section.section), written);
  return { slice, value: written };
}

// --- lookups ----------------------------------------------------------------------

/** The merged section `sectionId` names, refusing rather than inventing one. */
function requireSection(ctx: WriteContext, sectionId: string): MergedTodoSection {
  const section = ctx.merged.sections.find((s) => s.section.id === sectionId);
  if (!section) {
    throw new ShoppingWriteError('no_such_section', `no section with id ${sectionId}`);
  }
  return section;
}

interface FoundItem {
  readonly item: MergedTodoItem;
  readonly section: MergedTodoSection;
}

/** The merged item `itemId` names, together with the section it hangs off. */
function requireItem(ctx: WriteContext, itemId: string): FoundItem {
  for (const section of ctx.merged.sections) {
    for (const item of section.items) {
      if (item.item.id === itemId) return { item, section };
    }
  }
  throw new ShoppingWriteError('no_such_item', `no item with id ${itemId}`);
}

// --- slice edits ------------------------------------------------------------------

/** Replace our row for this section, or append it. */
function upsertSection(slice: ShoppingListSnapshot, section: TodoSection): ShoppingListSnapshot {
  const sections = slice.sections.some((s) => s.id === section.id)
    ? slice.sections.map((s) => (s.id === section.id ? section : s))
    : [...slice.sections, section];
  return { ...slice, sections };
}

/**
 * Insert `section` **only if we do not already hold it** — the adoption half of
 * `observePeerItem`.
 *
 * Never overwrites a row of ours: our own state must not be clobbered by a peer's copy
 * of it, which may be older. (In the app this is also why the insert must never be a
 * `REPLACE`, which would delete the section row and cascade its items away — `lc-0zo`.
 * There is no cascade here, but the rule that our row wins is the same one.)
 */
function adoptSection(slice: ShoppingListSnapshot, section: TodoSection): ShoppingListSnapshot {
  if (slice.sections.some((s) => s.id === section.id)) return slice;
  return { ...slice, sections: [...slice.sections, section] };
}

/** Replace our observation of this item, or record one. */
function upsertItem(slice: ShoppingListSnapshot, item: TodoItem): ShoppingListSnapshot {
  const items = slice.items.some((i) => i.id === item.id)
    ? slice.items.map((i) => (i.id === item.id ? item : i))
    : [...slice.items, item];
  return { ...slice, items };
}

/** Our row for `itemId` after a write has landed; the write put it there. */
function sliceItem(slice: ShoppingListSnapshot, itemId: string): TodoItem {
  const item = slice.items.find((i) => i.id === itemId);
  if (!item) throw new ShoppingWriteError('no_such_item', `no item with id ${itemId}`);
  return item;
}

// --- slots ------------------------------------------------------------------------

/**
 * The slot an appended row goes in: one past the lowest foot both we and the merged view
 * can see (`lc-bif`).
 *
 * The GREATER of the two, rather than the merged view outright, because they answer the
 * same question from different distances. Ours is authoritative about the rows we hold
 * and blind to peers'; the merged one sees the whole list but may lag a write that just
 * landed — and taking it verbatim would let a stale view drop a row onto a slot one of
 * our own rows already occupies. Neither can be low: the maximum is at least each.
 *
 * Cleared rows are counted on both sides, matching `TodoDao.maxItemSortOrder`: a cleared
 * item keeps its slot and returns to it when restored.
 */
function nextItemSlot(ctx: WriteContext, section: MergedTodoSection): number {
  const ours = maxOr(
    ctx.own.items.filter((i) => i.sectionId === section.section.id).map((i) => i.sortOrder),
  );
  const merged = maxOr(section.items.map((i) => i.item.sortOrder));
  return Math.max(ours, merged) + 1;
}

/** {@link nextItemSlot} for sections, which are numbered in the same way. */
function nextSectionSlot(ctx: WriteContext): number {
  const ours = maxOr(ctx.own.sections.map((s) => s.sortOrder));
  const merged = maxOr(ctx.merged.sections.map((s) => s.section.sortOrder));
  return Math.max(ours, merged) + 1;
}

function maxOr(values: readonly number[]): number {
  return values.reduce((max, value) => (value > max ? value : max), -1);
}

/**
 * Clamp a requested index into the list rather than refusing it.
 *
 * "Move it to the bottom" arrives from a model as whatever number it believed the list
 * length to be, and a list that changed under it is the normal case on a shared list —
 * so an out-of-range index means the end, not an error.
 */
function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(length - 1, 0));
}
