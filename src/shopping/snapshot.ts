import { arr, asObject, int, intOr, optStr, parseJsonObject, str } from '../sync/json.js';
import { clampIndent, type TodoItem, type TodoSection } from './model.js';

/**
 * The shopping-list slice as it travels: the plaintext JSON that goes inside an
 * envelope. Port of `ShoppingListSnapshot` and its two row snapshots from
 * `sync/Snapshots.kt`.
 *
 * ## Why this is a codec and not `JSON.stringify(rows)`
 * The app decodes this with `kotlinx.serialization` configured
 * `ignoreUnknownKeys = true, explicitNulls = false, encodeDefaults = false`
 * (`HttpTolarApi.defaultJson`). Two halves of that matter here and neither fails
 * loudly:
 *
 * - **Absent means default, and default is written as absent.** A null stamp, an
 *   `indentLevel` of 0, an empty list — the app omits them, and a peer on a build that
 *   predates a column omits it because it has never heard of it. Both decode to the
 *   same thing, which is what lets an old build and a new one share a list at all. So
 *   this encoder omits them too: a slice full of explicit `"stateChangedAt": null` is
 *   *accepted* by the app but is a gratuitous divergence in bytes the tests compare.
 * - **An absent field is not an error.** Every optional field here decodes to its
 *   documented default rather than throwing, because the writer of this slice may be
 *   older than the reader — which is the normal state of a shared list mid-rollout.
 *
 * `nameNormalized` is deliberately not on the wire: the app re-derives it on rehydrate
 * (it is a local index for autocomplete), and publishing our own casefolding of a
 * peer's name would be publishing a derived value as if it were data.
 */
export interface ShoppingListSnapshot {
  /** Schema version. Absent on the wire while it equals {@link SHOPPING_SCHEMA}. */
  readonly v: number;
  readonly sections: readonly TodoSection[];
  readonly items: readonly TodoItem[];
}

/** The one schema version that exists (`ShoppingListSnapshot.SCHEMA`). */
export const SHOPPING_SCHEMA = 1;

/** An empty slice — what an author who has never published one is taken to hold. */
export const EMPTY_SNAPSHOT: ShoppingListSnapshot = {
  v: SHOPPING_SCHEMA,
  sections: [],
  items: [],
};

/**
 * Encode a slice to the exact JSON shape the app decodes, omitting every field that
 * equals its default. See the note on {@link ShoppingListSnapshot} for why the
 * omissions are the point rather than a size optimisation.
 */
export function encodeShoppingSnapshot(snapshot: ShoppingListSnapshot): string {
  const out: Record<string, unknown> = {};
  if (snapshot.v !== SHOPPING_SCHEMA) out.v = snapshot.v;
  if (snapshot.sections.length > 0) out.sections = snapshot.sections.map(encodeSection);
  if (snapshot.items.length > 0) out.items = snapshot.items.map(encodeItem);
  return JSON.stringify(out);
}

/** {@link encodeShoppingSnapshot} as the UTF-8 bytes an envelope seals. */
export function encodeShoppingSnapshotBytes(snapshot: ShoppingListSnapshot): Uint8Array {
  return Buffer.from(encodeShoppingSnapshot(snapshot), 'utf8');
}

/**
 * Decode a slice, filling in every omitted field with the default the app would use.
 *
 * Unknown keys are ignored (`ignoreUnknownKeys = true`): the app is allowed to grow a
 * column this peer has never heard of, and a slice carrying one must still merge here
 * rather than being skipped as malformed. The cost is that this peer then republishes
 * its own observation *without* that column, which is the same one-directional loss a
 * pre-upgrade phone already has, and the same one the app documents for `deletedAt`.
 *
 * @throws {import('../sync/json.js').DecodeError} if a required field is missing or of
 *   the wrong type — a slice with no `id` on an item is not an older build, it is
 *   corrupt, and merging it would mint an item under `undefined`.
 */
export function decodeShoppingSnapshot(text: string): ShoppingListSnapshot {
  const what = 'shoppinglist';
  const root = parseJsonObject(text, what);
  return {
    v: intOr(root, 'v', SHOPPING_SCHEMA, what),
    sections: arr(root, 'sections', what).map((s, i) =>
      decodeSection(asObject(s, `${what}.sections[${i}]`), `${what}.sections[${i}]`),
    ),
    items: arr(root, 'items', what).map((s, i) =>
      decodeItem(asObject(s, `${what}.items[${i}]`), `${what}.items[${i}]`),
    ),
  };
}

/** {@link decodeShoppingSnapshot} over the plaintext bytes an envelope opened to. */
export function decodeShoppingSnapshotBytes(bytes: Uint8Array): ShoppingListSnapshot {
  return decodeShoppingSnapshot(Buffer.from(bytes).toString('utf8'));
}

function encodeSection(section: TodoSection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: section.id,
    title: section.title,
    createdAt: section.createdAt,
  };
  if (section.titleChangedAt !== null) out.titleChangedAt = section.titleChangedAt;
  if (section.deletedAt !== null) out.deletedAt = section.deletedAt;
  out.sortOrder = section.sortOrder;
  return out;
}

function encodeItem(item: TodoItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    sectionId: item.sectionId,
    name: item.name,
    addedDate: item.addedDate,
  };
  if (item.checkedOffDate !== null) out.checkedOffDate = item.checkedOffDate;
  if (item.clearedDate !== null) out.clearedDate = item.clearedDate;
  if (item.stateChangedAt !== null) out.stateChangedAt = item.stateChangedAt;
  if (item.layoutChangedAt !== null) out.layoutChangedAt = item.layoutChangedAt;
  out.sortOrder = item.sortOrder;
  if (item.footnote !== null) out.footnote = item.footnote;
  if (item.footnoteSub !== null) out.footnoteSub = item.footnoteSub;
  if (item.indentLevel !== 0) out.indentLevel = item.indentLevel;
  return out;
}

function decodeSection(o: Record<string, unknown>, what: string): TodoSection {
  return {
    id: str(o, 'id', what),
    title: str(o, 'title', what),
    createdAt: int(o, 'createdAt', what),
    titleChangedAt: optInt(o, 'titleChangedAt', what),
    deletedAt: optInt(o, 'deletedAt', what),
    sortOrder: int(o, 'sortOrder', what),
  };
}

function decodeItem(o: Record<string, unknown>, what: string): TodoItem {
  return {
    id: str(o, 'id', what),
    sectionId: str(o, 'sectionId', what),
    name: str(o, 'name', what),
    addedDate: int(o, 'addedDate', what),
    checkedOffDate: optInt(o, 'checkedOffDate', what),
    clearedDate: optInt(o, 'clearedDate', what),
    stateChangedAt: optInt(o, 'stateChangedAt', what),
    layoutChangedAt: optInt(o, 'layoutChangedAt', what),
    sortOrder: int(o, 'sortOrder', what),
    footnote: optStr(o, 'footnote', what),
    footnoteSub: optStr(o, 'footnoteSub', what),
    // Clamped on the way in, exactly as `TodoItemSnapshot.toItem` does: a peer is not a
    // trusted source for a value whose whole contract is that it is 0 or 1.
    indentLevel: clampIndent(intOr(o, 'indentLevel', 0, what)),
  };
}

/** An epoch-millis stamp that is absent when this author has nothing to report. */
function optInt(o: Record<string, unknown>, key: string, what: string): number | null {
  return o[key] === undefined || o[key] === null ? null : int(o, key, what);
}
