import { describe, expect, it } from 'vitest';
import { mergeCards, type SharedCards } from '../src/merge/cardMerge.js';
import { cardOf } from './support/fakeBackend.js';

/**
 * `CardMerge`, from this peer's seat.
 *
 * The dedup rule is the whole of it, and it is format-aware for a reason: the same
 * digits under two symbologies are two different cards, and a photo-only card has no
 * code to be a duplicate of. The precedence rule matters just as much — a card the
 * agent authored must never be reported as somebody else's, and vice versa, because
 * that attribution is what tells the caller which cards it may edit.
 */
function sharedBy(authorUuid: string, cards: SharedCards['cards']): SharedCards {
  return { authorUuid, displayName: null, kind: 'person', cards };
}

describe('mergeCards', () => {
  it('marks the agent’s own cards own, and a peer’s as shared by them', () => {
    const merged = mergeCards(
      [cardOf({ id: 'mine', title: 'Mine' })],
      [sharedBy('user-1', [cardOf({ id: 'theirs', title: 'Theirs' })])],
    );
    expect(merged.map((m) => m.provenance.kind)).toEqual(['own', 'sharedBy']);
    expect(merged[1]!.provenance).toMatchObject({ authorUuid: 'user-1' });
  });

  it('drops a peer’s card that duplicates one we already hold', () => {
    const merged = mergeCards(
      [cardOf({ id: 'mine', title: 'Cafe', barcodeValue: '123', barcodeFormat: 'EAN_13' })],
      [
        sharedBy('user-1', [
          cardOf({ id: 'theirs', title: 'Cafe', barcodeValue: '123', barcodeFormat: 'EAN_13' }),
        ]),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.card.id).toBe('mine');
  });

  it('keeps the same digits under a different symbology — a different card', () => {
    const merged = mergeCards(
      [cardOf({ id: 'mine', title: 'A', barcodeValue: '123', barcodeFormat: 'EAN_13' })],
      [
        sharedBy('user-1', [
          cardOf({ id: 'theirs', title: 'B', barcodeValue: '123', barcodeFormat: 'ITF' }),
        ]),
      ],
    );
    expect(merged).toHaveLength(2);
  });

  it('never dedups photo-only cards, which carry no code at all', () => {
    const merged = mergeCards(
      [cardOf({ id: 'mine', title: 'Photo' })],
      [
        sharedBy('user-1', [
          cardOf({ id: 'a', title: 'Photo' }),
          cardOf({ id: 'b', title: 'Photo' }),
        ]),
      ],
    );
    expect(merged.map((m) => m.card.id)).toEqual(['mine', 'a', 'b']);
  });

  it('does not collide a value that looks like value-plus-format', () => {
    // Guards the code key's separator: `("123 ITF", null)` is not `("123", "ITF")`.
    const merged = mergeCards(
      [cardOf({ id: 'mine', title: 'A', barcodeValue: '123', barcodeFormat: 'ITF' })],
      [sharedBy('user-1', [cardOf({ id: 'theirs', title: 'B', barcodeValue: '123 ITF' })])],
    );
    expect(merged).toHaveLength(2);
  });

  it('breaks a tie between two sharers on author uuid, not on fetch order', () => {
    const dup = { title: 'Cafe', barcodeValue: '9', barcodeFormat: 'ITF' } as const;
    const zed = sharedBy('zed', [cardOf({ id: 'z', ...dup })]);
    const abe = sharedBy('abe', [cardOf({ id: 'a', ...dup })]);
    expect(mergeCards([], [zed, abe]).map((m) => m.card.id)).toEqual(['a']);
    expect(mergeCards([], [abe, zed]).map((m) => m.card.id)).toEqual(['a']);
  });

  it('carries the agent label through, so a badge can say a machine wrote this', () => {
    const merged = mergeCards(
      [],
      [
        {
          authorUuid: 'bot',
          displayName: 'Ada',
          kind: 'agent',
          cards: [cardOf({ id: 'c', title: 'C' })],
        },
      ],
    );
    expect(merged[0]!.provenance).toMatchObject({ connectionKind: 'agent', displayName: 'Ada' });
  });
});
