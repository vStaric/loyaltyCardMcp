import { describe, expect, it } from 'vitest';
import { CONNECTION_KIND_AGENT } from '../src/sharing/connectInvite.js';
import { activeItems, mergeShoppingSlices } from '../src/shopping/merge.js';
import { HIGH_UUID, LOW_UUID, item, section, slice } from './shoppingFixtures.js';

/**
 * The merge, against the cases the Android app's `ShoppingMergeTest` pins.
 *
 * This is one half of what keeps two implementations of the same CRDT honest (the other
 * is the stamp discipline, in `shoppingWriter.test.ts`). Every case here is a rule the
 * app already relies on, so a divergence is not a difference of opinion — it is this
 * peer silently reverting something on the user's phone.
 */

const ME = LOW_UUID;
const PEER = HIGH_UUID;

describe('membership', () => {
  it('is an identity over a single author, everything attributed to us', () => {
    const merged = mergeShoppingSlices(
      [slice(ME, [section('s')], [item('a', 's'), item('b', 's', { sortOrder: 1 })])],
      ME,
    );
    expect(merged.sections).toHaveLength(1);
    expect(merged.sections[0]!.items.map((i) => i.item.id)).toEqual(['a', 'b']);
    expect(merged.sections[0]!.items.every((i) => i.provenance.kind === 'own')).toBe(true);
    expect(merged.observedByPeers.size).toBe(0);
  });

  it('unions distinct items from two authors under a shared section', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('mine', 's')]),
        slice(PEER, [section('s')], [item('theirs', 's', { sortOrder: 1 })]),
      ],
      ME,
    );
    expect(merged.sections[0]!.items.map((i) => i.item.id)).toEqual(['mine', 'theirs']);
  });

  it('lets a tombstone from any author remove the item', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's')]),
        slice(PEER, [section('s')], [item('a', 's', { clearedDate: 2_000 })]),
      ],
      ME,
    );
    expect(activeItems(merged.sections[0]!)).toHaveLength(0);
  });

  it('lets a re-add under a fresh id survive an old tombstone of the prior id', () => {
    const merged = mergeShoppingSlices(
      [
        slice(
          ME,
          [section('s')],
          [item('old', 's', { clearedDate: 2_000 }), item('new', 's', { addedDate: 3_000 })],
        ),
      ],
      ME,
    );
    expect(activeItems(merged.sections[0]!).map((i) => i.item.id)).toEqual(['new']);
  });

  it('drops an item whose section is in no slice', () => {
    const merged = mergeShoppingSlices([slice(ME, [], [item('orphan', 'gone')])], ME);
    expect(merged.sections).toHaveLength(0);
  });

  it('yields an empty list from no slices at all', () => {
    expect(mergeShoppingSlices([], ME).sections).toHaveLength(0);
  });
});

describe('content LWW', () => {
  it('resolves check-state last-writer-wins across authors', () => {
    const merged = mergeShoppingSlices(
      [
        slice(
          ME,
          [section('s')],
          [item('a', 's', { checkedOffDate: 2_000, stateChangedAt: 2_000 })],
        ),
        slice(
          PEER,
          [section('s')],
          [item('a', 's', { checkedOffDate: 3_000, stateChangedAt: 3_000 })],
        ),
      ],
      ME,
    );
    expect(merged.sections[0]!.items[0]!.item.checkedOffDate).toBe(3_000);
  });

  it('lets a later uncheck beat an earlier check — the stamp cannot move backwards', () => {
    // lc-99a: unchecking nulls checkedOffDate, so without stateChangedAt this
    // observation's stamp DROPS back to addedDate and the peer's check keeps winning.
    const merged = mergeShoppingSlices(
      [
        slice(
          ME,
          [section('s')],
          [item('a', 's', { checkedOffDate: null, stateChangedAt: 3_000 })],
        ),
        slice(
          PEER,
          [section('s')],
          [item('a', 's', { checkedOffDate: 2_000, stateChangedAt: 2_000 })],
        ),
      ],
      ME,
    );
    expect(merged.sections[0]!.items[0]!.item.checkedOffDate).toBeNull();
  });

  it('still compares a slice with no stateChangedAt on its other stamps', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's', { checkedOffDate: 5_000 })]),
        slice(
          PEER,
          [section('s')],
          [item('a', 's', { checkedOffDate: 2_000, stateChangedAt: 2_000 })],
        ),
      ],
      ME,
    );
    expect(merged.sections[0]!.items[0]!.item.checkedOffDate).toBe(5_000);
  });

  it('breaks an equal-stamp tie by the greater author uuid, not by whoever is local', () => {
    const tied = { checkedOffDate: 2_000, stateChangedAt: 2_000 };
    const fromLow = mergeShoppingSlices(
      [
        slice(LOW_UUID, [section('s')], [item('a', 's', { ...tied, name: 'low' })]),
        slice(HIGH_UUID, [section('s')], [item('a', 's', { ...tied, name: 'high' })]),
      ],
      LOW_UUID,
    );
    const fromHigh = mergeShoppingSlices(
      [
        slice(LOW_UUID, [section('s')], [item('a', 's', { ...tied, name: 'low' })]),
        slice(HIGH_UUID, [section('s')], [item('a', 's', { ...tied, name: 'high' })]),
      ],
      HIGH_UUID,
    );
    expect(fromLow.sections[0]!.items[0]!.item.name).toBe('high');
    expect(fromHigh.sections[0]!.items[0]!.item.name).toBe('high');
  });
});

describe('placement is its own comparator', () => {
  it('keeps a moved row in its new slot against an untouched observation', () => {
    // lc-c3j: unstamped, the move ties with the peer's copy and loses on the uuid.
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's', { sortOrder: 3, layoutChangedAt: 5_000 })]),
        slice(PEER, [section('s')], [item('a', 's', { sortOrder: 0 })]),
      ],
      ME,
    );
    expect(merged.sections[0]!.items[0]!.item.sortOrder).toBe(3);
  });

  it('carries an indent the same way a move is carried', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's', { indentLevel: 1, layoutChangedAt: 5_000 })]),
        slice(PEER, [section('s')], [item('a', 's')]),
      ],
      ME,
    );
    expect(merged.sections[0]!.items[0]!.item.indentLevel).toBe(1);
  });

  it('does not let a move carry the mover’s stale check-state', () => {
    // The whole reason placement has its own stamp: our move is the newest LAYOUT
    // observation, and the peer's check is the newest CONTENT one. Both must land.
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's', { sortOrder: 4, layoutChangedAt: 9_000 })]),
        slice(
          PEER,
          [section('s')],
          [item('a', 's', { checkedOffDate: 6_000, stateChangedAt: 6_000 })],
        ),
      ],
      ME,
    );
    const resolved = merged.sections[0]!.items[0]!.item;
    expect(resolved.sortOrder).toBe(4);
    expect(resolved.checkedOffDate).toBe(6_000);
  });

  it('does not let a text edit move a row somebody else has since dragged', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's', { name: 'edited', stateChangedAt: 9_000 })]),
        slice(PEER, [section('s')], [item('a', 's', { sortOrder: 7, layoutChangedAt: 6_000 })]),
      ],
      ME,
    );
    const resolved = merged.sections[0]!.items[0]!.item;
    expect(resolved.name).toBe('edited');
    expect(resolved.sortOrder).toBe(7);
  });

  it('orders items sharing a slot by id, identically on every device', () => {
    const merged = mergeShoppingSlices(
      [slice(ME, [section('s')], [item('b', 's')]), slice(PEER, [section('s')], [item('a', 's')])],
      ME,
    );
    expect(merged.sections[0]!.items.map((i) => i.item.id)).toEqual(['a', 'b']);
  });
});

describe('sections', () => {
  it('resolves a rename against its own stamp, without carrying the renamer’s slot', () => {
    // lc-l85: the title comes from the title winner; everything else from the section
    // representative, which is picked on createdAt.
    const merged = mergeShoppingSlices(
      [
        slice(
          ME,
          [section('s', { title: 'Renamed', titleChangedAt: 9_000, sortOrder: 5 })],
          [item('a', 's')],
        ),
        slice(PEER, [section('s', { title: 'Original', createdAt: 2_000, sortOrder: 1 })], []),
      ],
      ME,
    );
    expect(merged.sections[0]!.section.title).toBe('Renamed');
    expect(merged.sections[0]!.section.sortOrder).toBe(1);
  });

  it('delivers the winning title with its own stamp attached', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s', { title: 'Renamed', titleChangedAt: 9_000 })], [item('a', 's')]),
        slice(PEER, [section('s', { createdAt: 2_000 })], []),
      ],
      ME,
    );
    expect(merged.sections[0]!.section.titleChangedAt).toBe(9_000);
  });

  it('removes a section one author tombstoned once nothing live is left in it', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s', { deletedAt: 5_000 })], [item('a', 's', { clearedDate: 5_000 })]),
        slice(PEER, [section('s')], [item('a', 's')]),
      ],
      ME,
    );
    expect(merged.sections).toHaveLength(0);
  });

  it('keeps a tombstoned section while any author still has something live in it', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s', { deletedAt: 5_000 })], []),
        slice(PEER, [section('s')], [item('a', 's')]),
      ],
      ME,
    );
    expect(merged.sections).toHaveLength(1);
  });

  it('does not treat a merely emptied section as a removed one', () => {
    const merged = mergeShoppingSlices([slice(ME, [section('s')], [])], ME);
    expect(merged.sections).toHaveLength(1);
  });

  it('unions the tombstone and keeps the instant it was first reported', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s', { deletedAt: 9_000 })], [item('a', 's')]),
        slice(PEER, [section('s', { deletedAt: 5_000 })], []),
      ],
      ME,
    );
    expect(merged.sections[0]!.section.deletedAt).toBe(5_000);
  });

  it('sorts sections by slot', () => {
    const merged = mergeShoppingSlices(
      [slice(ME, [section('b', { sortOrder: 1 }), section('a', { sortOrder: 0 })], [])],
      ME,
    );
    expect(merged.sections.map((s) => s.section.id)).toEqual(['a', 'b']);
  });
});

describe('provenance', () => {
  it('names the author whose observation won, with the label the roster gave them', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], []),
        slice(PEER, [section('s')], [item('a', 's')], {
          displayName: 'Ada',
          connectionKind: CONNECTION_KIND_AGENT,
        }),
      ],
      ME,
    );
    const provenance = merged.sections[0]!.items[0]!.provenance;
    expect(provenance).toMatchObject({
      kind: 'shared',
      authorUuid: PEER,
      displayName: 'Ada',
      connectionKind: CONNECTION_KIND_AGENT,
    });
  });

  it('flips to own the moment our observation wins — which is what own means', () => {
    const merged = mergeShoppingSlices(
      [
        slice(
          ME,
          [section('s')],
          [item('a', 's', { checkedOffDate: 9_000, stateChangedAt: 9_000 })],
        ),
        slice(PEER, [section('s')], [item('a', 's')]),
      ],
      ME,
    );
    expect(merged.sections[0]!.items[0]!.provenance.kind).toBe('own');
  });
});

describe('observedByPeers', () => {
  it('holds ids another author published, whoever is winning', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('a', 's', { stateChangedAt: 9_000 })]),
        slice(PEER, [section('s')], [item('a', 's')]),
      ],
      ME,
    );
    // Ours won the merge, so provenance says `own` — and the peer still holds a row,
    // which is exactly the distinction a removal has to make (lc-2wh).
    expect(merged.sections[0]!.items[0]!.provenance.kind).toBe('own');
    expect(merged.observedByPeers.has('a')).toBe(true);
  });

  it('includes an id only a peer’s tombstone mentions, and never our own rows', () => {
    const merged = mergeShoppingSlices(
      [
        slice(ME, [section('s')], [item('mine', 's')]),
        slice(PEER, [section('s')], [item('theirs', 's', { clearedDate: 2_000 })]),
      ],
      ME,
    );
    expect([...merged.observedByPeers]).toEqual(['theirs']);
  });
});
