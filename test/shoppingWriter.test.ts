import { describe, expect, it } from 'vitest';
import {
  activeItems,
  mergeShoppingSlices,
  type MergedShoppingList,
} from '../src/shopping/merge.js';
import type { TodoItem } from '../src/shopping/model.js';
import type { ShoppingListSnapshot } from '../src/shopping/snapshot.js';
import {
  addItems,
  createSection,
  moveItem,
  removeItem,
  renameItem,
  renameSection,
  setChecked,
  setFootnote,
  ShoppingWriteError,
  type WriteContext,
} from '../src/shopping/writer.js';
import { HIGH_UUID, LOW_UUID, item, section, snapshot } from './shoppingFixtures.js';

/**
 * The write-stamp discipline (PRD-agent-connection §4.1) — the whole implementation risk
 * of this bead.
 *
 * Each rule is checked twice, on purpose:
 *
 * 1. **Directly**, that the write moves exactly the stamps it should and leaves the
 *    others alone. A stamp moved that should not be is as much a bug as one that is not
 *    — that is what `lc-c3j` was.
 * 2. **Through the merge**, against a peer's stale observation of the same id, which is
 *    the shape every one of these bugs actually took: the write succeeded locally and
 *    was silently reverted on the user's phone. A field assertion alone would not have
 *    caught any of them, because the field was always written; what was missing was the
 *    stamp that let it win.
 *
 * This peer's uuid is deliberately the **lower** of the two throughout, so an unstamped
 * write loses every tie and the regression tests fail rather than passing by luck.
 */

const AGENT = LOW_UUID;
const USER = HIGH_UUID;
const NOW = 9_000;

/** A context over our slice plus the user's, merged the way a read would. */
function context(
  own: ShoppingListSnapshot,
  userSlice: ShoppingListSnapshot = snapshot([], []),
  now = NOW,
): WriteContext {
  const merged = mergeShoppingSlices(
    [
      { authorUuid: AGENT, displayName: null, snapshot: own },
      { authorUuid: USER, displayName: 'the user', snapshot: userSlice },
    ],
    AGENT,
  );
  let next = 0;
  return { own, merged, now, newId: () => `new-${next++}` };
}

/** What the user's phone shows after our slice and theirs are merged again. */
function reMerge(ours: ShoppingListSnapshot, theirs: ShoppingListSnapshot): MergedShoppingList {
  return mergeShoppingSlices(
    [
      { authorUuid: AGENT, displayName: null, snapshot: ours },
      { authorUuid: USER, displayName: 'the user', snapshot: theirs },
    ],
    // Merged from the USER's point of view: this is their device deciding, and their
    // uuid is the greater one, so anything of ours that ties is thrown away.
    USER,
  );
}

/** Our slice's items in the order the merge would show them: slot, then id. */
function orderOf(written: ShoppingListSnapshot): readonly string[] {
  return [...written.items]
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
    .map((i) => i.id);
}

function only(merged: MergedShoppingList): TodoItem {
  const items = merged.sections.flatMap((s) => s.items);
  expect(items).toHaveLength(1);
  return items[0]!.item;
}

describe('add', () => {
  it('stamps addedDate and nothing else', () => {
    const ctx = context(snapshot([section('s')], []));
    const { value } = addItems(ctx, 's', [{ name: '  Milk  ' }]);
    expect(value[0]).toMatchObject({
      name: 'Milk',
      addedDate: NOW,
      stateChangedAt: null,
      layoutChangedAt: null,
      checkedOffDate: null,
      clearedDate: null,
    });
  });

  it('adopts a section it does not hold before writing into it', () => {
    // lc-ing: an item can only exist under a section row the writer holds.
    const theirs = snapshot([section('s', { title: 'Dairy' })], []);
    const ctx = context(snapshot([], []), theirs);
    const { slice: written } = addItems(ctx, 's', [{ name: 'Milk' }]);
    expect(written.sections.map((s) => s.id)).toEqual(['s']);
    expect(written.sections[0]!.title).toBe('Dairy');
  });

  it('writes nothing at all when every name is blank', () => {
    // An abandoned add must not leave a peer's section republished in our slice as a
    // side effect of having been looked at.
    const ctx = context(snapshot([], []), snapshot([section('s')], []));
    const { slice: written, value } = addItems(ctx, 's', [{ name: '   ' }]);
    expect(value).toHaveLength(0);
    expect(written.sections).toHaveLength(0);
  });

  it('appends past the foot of the MERGED section, not just our own rows', () => {
    // lc-bif: numbering off our own rows alone lands the new item at slot 0, tied with
    // the peer's first row, and the id tiebreak surfaces it near the top of a list it
    // was added to the foot of.
    const theirs = snapshot(
      [section('s')],
      [item('t1', 's', { sortOrder: 0 }), item('t2', 's', { sortOrder: 1 })],
    );
    const ctx = context(snapshot([], []), theirs);
    const { value } = addItems(ctx, 's', [{ name: 'Milk' }, { name: 'Eggs' }]);
    expect(value.map((i) => i.sortOrder)).toEqual([2, 3]);
  });

  it('clamps an indent a caller asked for outside the one supported level', () => {
    const ctx = context(snapshot([section('s')], []));
    const { value } = addItems(ctx, 's', [{ name: 'Milk', indentLevel: 7 }]);
    expect(value[0]!.indentLevel).toBe(1);
  });

  it('refuses a section that is on no slice', () => {
    const ctx = context(snapshot([], []));
    expect(() => addItems(ctx, 'nope', [{ name: 'Milk' }])).toThrow(ShoppingWriteError);
  });
});

describe('rename (lc-39d)', () => {
  it('stamps stateChangedAt, and does not touch the layout stamp', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    const { value } = renameItem(ctx, 'a', ' Whole milk ');
    expect(value).toMatchObject({ name: 'Whole milk', stateChangedAt: NOW, layoutChangedAt: null });
  });

  it('survives the user’s untouched observation of the same id', () => {
    const theirs = snapshot([section('s')], [item('a', 's', { name: 'Milk' })]);
    const ctx = context(snapshot([], []), theirs);
    const written = renameItem(ctx, 'a', 'Whole milk').slice;
    expect(only(reMerge(written, theirs)).name).toBe('Whole milk');
  });

  it('refuses a blank name rather than publishing one', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    expect(() => renameItem(ctx, 'a', '   ')).toThrow(ShoppingWriteError);
  });

  it('refuses an item that is on no slice', () => {
    const ctx = context(snapshot([section('s')], []));
    expect(() => renameItem(ctx, 'ghost', 'x')).toThrow(ShoppingWriteError);
  });
});

describe('check and uncheck (lc-99a)', () => {
  it('stamps checkedOffDate and stateChangedAt on a check', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    expect(setChecked(ctx, 'a', true).value).toMatchObject({
      checkedOffDate: NOW,
      stateChangedAt: NOW,
    });
  });

  it('nulls checkedOffDate but still stamps stateChangedAt on an uncheck', () => {
    const ctx = context(
      snapshot([section('s')], [item('a', 's', { checkedOffDate: 5_000, stateChangedAt: 5_000 })]),
    );
    expect(setChecked(ctx, 'a', false).value).toMatchObject({
      checkedOffDate: null,
      stateChangedAt: NOW,
    });
  });

  it('un-checks the user’s checked item without it snapping back', () => {
    // Without the stamp our observation's content stamp would FALL to addedDate and the
    // user's check would keep winning — the row visibly re-checks itself.
    const theirs = snapshot(
      [section('s')],
      [item('a', 's', { checkedOffDate: 5_000, stateChangedAt: 5_000 })],
    );
    const ctx = context(snapshot([], []), theirs);
    const written = setChecked(ctx, 'a', false).slice;
    expect(only(reMerge(written, theirs)).checkedOffDate).toBeNull();
  });
});

describe('footnote (lc-39d)', () => {
  it('stamps stateChangedAt and stores an empty note as the real state it is', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    expect(setFootnote(ctx, 'a', '').value).toMatchObject({ footnote: '', stateChangedAt: NOW });
  });

  it('drops the sub-footnote when the note is unpinned', () => {
    const ctx = context(
      snapshot([section('s')], [item('a', 's', { footnote: 'n', footnoteSub: 'sub' })]),
    );
    expect(setFootnote(ctx, 'a', null).value).toMatchObject({
      footnote: null,
      footnoteSub: null,
      stateChangedAt: NOW,
    });
  });

  it('ignores a sub-footnote while the item carries no footnote', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    expect(setFootnote(ctx, 'a', null, 'orphan').value.footnoteSub).toBeNull();
  });

  it('survives the user’s untouched observation of the same id', () => {
    const theirs = snapshot([section('s')], [item('a', 's')]);
    const ctx = context(snapshot([], []), theirs);
    const written = setFootnote(ctx, 'a', 'the semi-skimmed kind').slice;
    expect(only(reMerge(written, theirs)).footnote).toBe('the semi-skimmed kind');
  });
});

describe('remove is a tombstone, never a delete', () => {
  it('stamps clearedDate and stateChangedAt, and keeps the row', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    const { slice: written, value } = removeItem(ctx, 'a');
    expect(value).toMatchObject({ clearedDate: NOW, stateChangedAt: NOW });
    expect(written.items).toHaveLength(1);
  });

  it('removes an item the user still holds a live observation of', () => {
    // A hard delete of our row would leave their live copy unopposed and the item would
    // simply come back on the next merge.
    const theirs = snapshot([section('s')], [item('a', 's')]);
    const ctx = context(snapshot([], []), theirs);
    const written = removeItem(ctx, 'a').slice;
    const merged = reMerge(written, theirs);
    expect(merged.sections[0]!.items).toHaveLength(1);
    expect(activeItems(merged.sections[0]!)).toHaveLength(0);
  });
});

describe('move (lc-c3j)', () => {
  it('stamps layoutChangedAt and NEVER the content stamp', () => {
    const ctx = context(
      snapshot(
        [section('s')],
        [item('a', 's', { sortOrder: 0 }), item('b', 's', { sortOrder: 1 })],
      ),
    );
    const { slice: written, value } = moveItem(ctx, 'a', { toIndex: 1 });
    expect(value).toMatchObject({ layoutChangedAt: NOW, stateChangedAt: null });
    expect(orderOf(written)).toEqual(['b', 'a']);
  });

  it('renumbers our other rows in the section so nothing collides', () => {
    const ctx = context(
      snapshot(
        [section('s')],
        [
          item('a', 's', { sortOrder: 0 }),
          item('b', 's', { sortOrder: 1 }),
          item('c', 's', { sortOrder: 2 }),
        ],
      ),
    );
    const { slice: written } = moveItem(ctx, 'c', { toIndex: 0 });
    const bySortOrder = [...written.items].sort((x, y) => x.sortOrder - y.sortOrder);
    expect(bySortOrder.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('lands where asked among the user’s rows, and does not adopt them', () => {
    // Adopting a peer's row to renumber it would republish their content under our
    // authorship at an identical stamp — where our uuid is the greater one that
    // re-attributes their whole section to the agent.
    const theirs = snapshot(
      [section('s')],
      [
        item('t0', 's', { sortOrder: 0 }),
        item('t1', 's', { sortOrder: 1 }),
        item('t2', 's', { sortOrder: 2 }),
      ],
    );
    const ctx = context(snapshot([], []), theirs);
    const { slice: written } = moveItem(ctx, 't2', { toIndex: 0 });
    expect(written.items.map((i) => i.id)).toEqual(['t2']);
    const order = reMerge(written, theirs).sections[0]!.items.map((i) => i.item.id);
    expect(order).toEqual(['t2', 't0', 't1']);
  });

  it('keeps the moved row’s new slot against the user’s untouched observation', () => {
    const theirs = snapshot(
      [section('s')],
      [item('a', 's', { sortOrder: 0 }), item('b', 's', { sortOrder: 1 })],
    );
    const ctx = context(snapshot([], []), theirs);
    const written = moveItem(ctx, 'a', { toIndex: 1 }).slice;
    expect(reMerge(written, theirs).sections[0]!.items.map((i) => i.item.id)).toEqual(['b', 'a']);
  });

  it('does not carry our stale copy of the user’s check-state along with the slot', () => {
    // The row we move is a snapshot of the moment we read it. If the user checks it
    // meanwhile, the check must still win, because our move raised only the layout stamp.
    const before = snapshot([section('s')], [item('a', 's'), item('b', 's', { sortOrder: 1 })]);
    const ctx = context(snapshot([], []), before);
    const written = moveItem(ctx, 'a', { toIndex: 1 }).slice;
    const after = snapshot(
      [section('s')],
      [
        item('a', 's', { checkedOffDate: 20_000, stateChangedAt: 20_000 }),
        item('b', 's', { sortOrder: 1 }),
      ],
    );
    const merged = reMerge(written, after);
    const moved = merged.sections[0]!.items.find((i) => i.item.id === 'a')!.item;
    expect(moved.checkedOffDate).toBe(20_000);
    expect(merged.sections[0]!.items.map((i) => i.item.id)).toEqual(['b', 'a']);
  });

  it('nests a row on the layout stamp, and clamps the level', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    const { value } = moveItem(ctx, 'a', { indentLevel: 4 });
    expect(value).toMatchObject({ indentLevel: 1, layoutChangedAt: NOW, stateChangedAt: null });
  });

  it('treats an out-of-range index as the end rather than refusing', () => {
    const ctx = context(
      snapshot(
        [section('s')],
        [item('a', 's', { sortOrder: 0 }), item('b', 's', { sortOrder: 1 })],
      ),
    );
    expect(orderOf(moveItem(ctx, 'a', { toIndex: 99 }).slice)).toEqual(['b', 'a']);
  });

  it('refuses a move that asks for nothing', () => {
    const ctx = context(snapshot([section('s')], [item('a', 's')]));
    expect(() => moveItem(ctx, 'a', {})).toThrow(ShoppingWriteError);
  });
});

describe('sections', () => {
  it('creates one past the foot of the merged list', () => {
    const ctx = context(snapshot([], []), snapshot([section('s', { sortOrder: 3 })], []));
    expect(createSection(ctx, ' Dairy ').value).toMatchObject({
      title: 'Dairy',
      createdAt: NOW,
      sortOrder: 4,
      titleChangedAt: null,
    });
  });

  it('renames on titleChangedAt alone, leaving createdAt and the slot as they were', () => {
    const ctx = context(snapshot([section('s', { createdAt: 100, sortOrder: 2 })], []));
    expect(renameSection(ctx, 's', 'Cheese').value).toMatchObject({
      title: 'Cheese',
      titleChangedAt: NOW,
      createdAt: 100,
      sortOrder: 2,
    });
  });

  it('adopts a section only the user holds in order to rename it', () => {
    // lc-l85: an update matches by id, so renaming a section we hold no row for wrote to
    // nothing at all. The insert IS the adoption.
    const theirs = snapshot([section('s', { title: 'Diary' })], [item('a', 's')]);
    const ctx = context(snapshot([], []), theirs);
    const written = renameSection(ctx, 's', 'Dairy').slice;
    expect(written.sections).toHaveLength(1);
    expect(reMerge(written, theirs).sections[0]!.section.title).toBe('Dairy');
  });

  it('carries a tombstone the user reported rather than arguing the section is back', () => {
    const theirs = snapshot([section('s', { deletedAt: 5_000 })], [item('a', 's')]);
    const ctx = context(snapshot([], []), theirs);
    const written = addItems(ctx, 's', [{ name: 'Milk' }]).slice;
    expect(written.sections[0]!.deletedAt).toBe(5_000);
  });
});
