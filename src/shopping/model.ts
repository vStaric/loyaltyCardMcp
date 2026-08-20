/**
 * The shopping list's two entities, ported from the Android app's Room rows
 * (`data/local/TodoItem.kt`, `data/local/TodoSection.kt`).
 *
 * They are ports rather than a fresh model because they are half of a **merge
 * contract**: `ShoppingMerge` resolves an item from up to three separate comparators
 * ({@link TodoItem.stateChangedAt}, {@link TodoItem.layoutChangedAt},
 * {@link TodoSection.titleChangedAt}), and a field this implementation invented — or
 * quietly dropped — would not fail loudly. It would silently lose a tiebreak on the
 * user's phone and revert something they typed.
 *
 * Two things the app's rows carry are deliberately absent here:
 * - `nameNormalized`, which Room stores for autocomplete and history aggregation and
 *   which the snapshot re-derives on rehydrate anyway. This peer has no autocomplete.
 * - the derived flags (`isActive`, `isChecked`, …), which are one-liners at the two
 *   call sites that want them and read better there than as methods on a plain object.
 */

/** Top level — the row sits on the list's own margin. */
export const INDENT_ROOT = 0;

/** The one nested level the app can render (`lc-6br`). */
export const INDENT_SUB = 1;

/**
 * Coerce an indent into `0..1`.
 *
 * The one level is a hard rule from the spec, not a default: an agent (or a peer on a
 * future build) must not be able to introduce a depth the app has no way to render or
 * to un-nest. Port of `TodoItem.clampIndent`.
 */
export function clampIndent(level: number): number {
  if (!Number.isFinite(level)) return INDENT_ROOT;
  return Math.min(Math.max(Math.trunc(level), INDENT_ROOT), INDENT_SUB);
}

/**
 * Canonical form used for matching: trimmed, internal whitespace runs collapsed to one
 * space, casefolded. Port of `TodoItem.normalize`, which uses `Locale.ROOT` so matching
 * is locale-stable; `toLowerCase()` here is the same choice — deliberately NOT
 * `toLocaleLowerCase()`, whose Turkish dotless-i would make the same two names match on
 * one host and not on another.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One occurrence of an item on the shopping list.
 *
 * Lifecycle is expressed purely through nullable dates: {@link addedDate} is always
 * set, {@link checkedOffDate} is set while checked, and {@link clearedDate} is the
 * **tombstone** — the row is retained forever as history and never deleted, because on
 * a shared list a deleted row leaves a peer's live observation unopposed and the item
 * returns on the next merge.
 */
export interface TodoItem {
  readonly id: string;
  readonly sectionId: string;
  readonly name: string;
  /** Epoch millis the item was added. Required, and never moved afterwards. */
  readonly addedDate: number;
  /** Epoch millis it was checked off; null while unchecked. */
  readonly checkedOffDate: number | null;
  /** Epoch millis it was cleared (tombstoned); null while it is on the active list. */
  readonly clearedDate: number | null;
  /**
   * Epoch millis this author last mutated the item's own **content** — its
   * check/cleared state (`lc-99a`) or its text: name, footnote, sub-footnote
   * (`lc-39d`). The shared list's content comparator, and it exists because nothing
   * else can serve: *unchecking* nulls {@link checkedOffDate} and so LOWERS the row's
   * apparent recency, and a *text edit* moves no date at all — leaving two
   * observations tied, decided by whose uuid sorts higher, so an untouched peer copy
   * reverted the edit about half the time.
   *
   * It covers content and nothing else. Where the row sits stamps
   * {@link layoutChangedAt} instead, and the two are compared separately.
   */
  readonly stateChangedAt: number | null;
  /**
   * Epoch millis this author last **moved** the row — reordered it ({@link sortOrder})
   * or nested it ({@link indentLevel}) — or null if it never has (`lc-c3j`).
   *
   * A separate column rather than more mutations on {@link stateChangedAt} because the
   * merge resolves each field group against its own stamp: whatever raises a stamp
   * carries the fields that stamp governs, so folding a drag into the content stamp
   * would have made it carry this author's possibly-stale check-state and text — and a
   * reorder rewrites a whole section at once, so it would have done so to every row in
   * it.
   */
  readonly layoutChangedAt: number | null;
  /** Position within its section; lower sorts first. Each author numbers their own rows. */
  readonly sortOrder: number;
  /** The Discworld footnote pinned to this item (`lc-nae`), or null when it carries none. */
  readonly footnote: string | null;
  /** The footnote's *own* footnote, or null. Meaningless while {@link footnote} is null. */
  readonly footnoteSub: string | null;
  /** How deep the row is nested: `0` or `1` and nothing else. See {@link clampIndent}. */
  readonly indentLevel: number;
}

/**
 * A titled group of {@link TodoItem}s.
 *
 * Sections are retained forever: one with no active items is hidden from the active
 * list but stays a target for adds. A section leaves by {@link deletedAt} tombstone,
 * and only once it is empty on every slice.
 */
export interface TodoSection {
  readonly id: string;
  readonly title: string;
  /** Epoch millis the section was first created; the section representative's comparator. */
  readonly createdAt: number;
  /**
   * Epoch millis this author last renamed the section, or null if it never has
   * (`lc-l85`) — the comparator for {@link title} and nothing else.
   *
   * Deliberately not folded into {@link createdAt}: that would make a rename win the
   * whole row, {@link sortOrder} included, which is the mistake
   * {@link TodoItem.layoutChangedAt} exists to avoid on the item side.
   */
  readonly titleChangedAt: number | null;
  /**
   * Epoch millis this author removed the section, or null while it has not (`lc-17q`).
   * Unioned across authors rather than raced, and conditional: a removed section
   * disappears only once it has no active items on any slice.
   *
   * This peer never *writes* it — there is no `remove_section` tool — but it is carried
   * verbatim through every read, adoption and republish, because dropping it would
   * republish a slice arguing that a section the user deleted is still there.
   */
  readonly deletedAt: number | null;
  /** Position in the list; lower sorts first. */
  readonly sortOrder: number;
}
