import { describe, expect, it } from 'vitest';
import { DecodeError } from '../src/sync/json.js';
import {
  decodeShoppingSnapshot,
  encodeShoppingSnapshot,
  SHOPPING_SCHEMA,
} from '../src/shopping/snapshot.js';
import { item, section, snapshot } from './shoppingFixtures.js';

/**
 * The slice's wire format, against the shape `kotlinx.serialization` produces and
 * consumes on the app's side (`explicitNulls = false, encodeDefaults = false,
 * ignoreUnknownKeys = true`).
 *
 * This is a format both implementations have to agree on and it does not fail loudly
 * when they stop: a field this peer writes under a name the app does not know is simply
 * dropped by the app's decoder, and the loss shows up later as an item that will not
 * check off.
 */

describe('encoding', () => {
  it('omits every field that equals its default, exactly as the app does', () => {
    const encoded = encodeShoppingSnapshot(
      snapshot([section('s', { createdAt: 10 })], [item('a', 's', { addedDate: 20 })]),
    );
    expect(JSON.parse(encoded)).toEqual({
      sections: [{ id: 's', title: 's', createdAt: 10, sortOrder: 0 }],
      items: [{ id: 'a', sectionId: 's', name: 'a', addedDate: 20, sortOrder: 0 }],
    });
  });

  it('writes every stamp that is actually set', () => {
    const encoded = JSON.parse(
      encodeShoppingSnapshot(
        snapshot(
          [section('s', { titleChangedAt: 1, deletedAt: 2 })],
          [
            item('a', 's', {
              checkedOffDate: 3,
              clearedDate: 4,
              stateChangedAt: 5,
              layoutChangedAt: 6,
              footnote: 'n',
              footnoteSub: 'sub',
              indentLevel: 1,
            }),
          ],
        ),
      ),
    ) as { sections: unknown[]; items: unknown[] };
    expect(encoded.sections[0]).toMatchObject({ titleChangedAt: 1, deletedAt: 2 });
    expect(encoded.items[0]).toMatchObject({
      checkedOffDate: 3,
      clearedDate: 4,
      stateChangedAt: 5,
      layoutChangedAt: 6,
      footnote: 'n',
      footnoteSub: 'sub',
      indentLevel: 1,
    });
  });

  it('omits an empty list entirely rather than writing an empty array', () => {
    expect(encodeShoppingSnapshot(snapshot([], []))).toBe('{}');
  });
});

describe('decoding', () => {
  it('round-trips a slice through the wire form', () => {
    const original = snapshot(
      [section('s', { titleChangedAt: 7 })],
      [item('a', 's', { stateChangedAt: 8, footnote: 'n' })],
    );
    expect(decodeShoppingSnapshot(encodeShoppingSnapshot(original))).toEqual(original);
  });

  it('reads a slice from a build that predates every optional column', () => {
    // Exactly what an older peer publishes: no stamps, no footnotes, no indent, no `v`.
    const decoded = decodeShoppingSnapshot(
      JSON.stringify({
        sections: [{ id: 's', title: 'Dairy', createdAt: 1, sortOrder: 0 }],
        items: [{ id: 'a', sectionId: 's', name: 'Milk', addedDate: 2, sortOrder: 0 }],
      }),
    );
    expect(decoded.v).toBe(SHOPPING_SCHEMA);
    expect(decoded.sections[0]).toMatchObject({ titleChangedAt: null, deletedAt: null });
    expect(decoded.items[0]).toMatchObject({
      checkedOffDate: null,
      clearedDate: null,
      stateChangedAt: null,
      layoutChangedAt: null,
      footnote: null,
      footnoteSub: null,
      indentLevel: 0,
    });
  });

  it('ignores a key it has never heard of, so a newer app still merges here', () => {
    const decoded = decodeShoppingSnapshot(
      JSON.stringify({
        items: [
          { id: 'a', sectionId: 's', name: 'Milk', addedDate: 2, sortOrder: 0, colour: 'red' },
        ],
      }),
    );
    expect(decoded.items).toHaveLength(1);
  });

  it('clamps an indent a peer reported outside the one supported level', () => {
    const decoded = decodeShoppingSnapshot(
      JSON.stringify({
        items: [{ id: 'a', sectionId: 's', name: 'x', addedDate: 1, sortOrder: 0, indentLevel: 9 }],
      }),
    );
    expect(decoded.items[0]!.indentLevel).toBe(1);
  });

  it('refuses a row with no id — that is corruption, not an older build', () => {
    expect(() =>
      decodeShoppingSnapshot(JSON.stringify({ items: [{ sectionId: 's', name: 'x' }] })),
    ).toThrow(DecodeError);
  });

  it('refuses something that is not JSON at all', () => {
    expect(() => decodeShoppingSnapshot('not json')).toThrow(DecodeError);
  });
});
