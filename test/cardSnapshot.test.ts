import { describe, expect, it } from 'vitest';
import { NO_PHOTOS, type Card } from '../src/cards/card.js';
import {
  CARDS_SNAPSHOT_SCHEMA,
  decodeCardsSnapshot,
  encodeCardsSnapshot,
} from '../src/sync/cardSnapshot.js';
import { DecodeError } from '../src/sync/json.js';
import { cardOf } from './support/fakeBackend.js';

/**
 * The `cards` blob codec.
 *
 * The assertions that matter here are about **absence**. The app encodes with
 * `encodeDefaults = false` / `explicitNulls = false`, so a field at its default is
 * simply not on the wire — and one of those fields, the photo tombstone, means
 * something different absent than it does `false`. A codec that normalised absence into
 * a value would let this peer publish a claim ("there is no photo here") that erases a
 * photo it never saw.
 */
describe('decodeCardsSnapshot', () => {
  it('reads a snapshot the app wrote: no `v`, no nulls, defaults absent', () => {
    const snapshot = decodeCardsSnapshot(
      JSON.stringify({
        cards: [{ id: 'c1', title: 'Cafe', createdAt: 10, updatedAt: 20, sortOrder: 3 }],
      }),
    );
    expect(snapshot.v).toBe(CARDS_SNAPSHOT_SCHEMA);
    const card = snapshot.cards[0]!;
    expect(card).toMatchObject({ id: 'c1', title: 'Cafe', notes: null, barcodeValue: null });
    expect(card.photos).toEqual(NO_PHOTOS);
  });

  it('keeps a photo pointer and its key', () => {
    const [card] = decodeCardsSnapshot(
      JSON.stringify({
        cards: [
          {
            id: 'c1',
            title: 'Cafe',
            createdAt: 1,
            updatedAt: 1,
            sortOrder: 0,
            frontBlob: { hash: 'abc', key: 'a2V5' },
          },
        ],
      }),
    ).cards;
    expect(card!.photos.front).toEqual({ hash: 'abc', key: 'a2V5' });
  });

  it('distinguishes a cleared slot from a slot the writer could not speak for', () => {
    const [card] = decodeCardsSnapshot(
      JSON.stringify({
        cards: [
          {
            id: 'c1',
            title: 'Cafe',
            createdAt: 1,
            updatedAt: 1,
            sortOrder: 0,
            frontBlobCleared: true,
          },
        ],
      }),
    ).cards;
    expect(card!.photos.frontCleared).toBe(true);
    // Never stated, and therefore not a claim that the slot is empty.
    expect(card!.photos.backCleared).toBeNull();
  });

  it('keeps a card whose barcode format this version cannot read', () => {
    const [card] = decodeCardsSnapshot(
      JSON.stringify({
        cards: [
          {
            id: 'c1',
            title: 'Cafe',
            barcodeValue: '123',
            barcodeFormat: 'DATA_MATRIX_9000',
            createdAt: 1,
            updatedAt: 1,
            sortOrder: 0,
          },
        ],
      }),
    ).cards;
    // The code survives; only the label saying how to draw it is dropped.
    expect(card!.barcodeValue).toBe('123');
    expect(card!.barcodeFormat).toBeNull();
  });

  it('accepts a newer schema tag rather than hiding every card behind it', () => {
    const snapshot = decodeCardsSnapshot(
      JSON.stringify({
        v: 99,
        cards: [{ id: 'c1', title: 'C', createdAt: 1, updatedAt: 1, sortOrder: 0 }],
      }),
    );
    expect(snapshot.v).toBe(99);
    expect(snapshot.cards).toHaveLength(1);
  });

  it('refuses a card missing a required field instead of inventing one', () => {
    expect(() => decodeCardsSnapshot(JSON.stringify({ cards: [{ id: 'c1' }] }))).toThrow(
      DecodeError,
    );
  });

  it('refuses something that is not JSON', () => {
    expect(() => decodeCardsSnapshot('not json')).toThrow(DecodeError);
  });
});

describe('encodeCardsSnapshot', () => {
  it('omits the schema tag and every null, the way the app does', () => {
    const json = encodeCardsSnapshot([cardOf({ id: 'c1', title: 'Cafe' })]);
    expect(JSON.parse(json)).toEqual({
      cards: [
        {
          id: 'c1',
          title: 'Cafe',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          sortOrder: 0,
        },
      ],
    });
  });

  it('emits an empty object for an empty list, not `cards: []`', () => {
    expect(encodeCardsSnapshot([])).toBe('{}');
  });

  it('never writes `cleared: false` — one spelling of silence is enough', () => {
    const card: Card = cardOf({
      id: 'c1',
      title: 'Cafe',
      photos: { ...NO_PHOTOS, frontCleared: true },
    });
    const written = JSON.parse(encodeCardsSnapshot([card])) as { cards: Record<string, unknown>[] };
    expect(written.cards[0]!.frontBlobCleared).toBe(true);
    expect(written.cards[0]).not.toHaveProperty('backBlobCleared');
  });

  it('round-trips a card with everything set', () => {
    const card = cardOf({
      id: 'c1',
      title: 'Cafe',
      notes: 'the good one',
      barcodeValue: '9501101530003',
      barcodeFormat: 'EAN_13',
      sortOrder: 7,
      photos: {
        front: { hash: 'h1', key: 'azE=' },
        back: null,
        logo: { hash: 'h2', key: 'azI=' },
        frontCleared: null,
        backCleared: true,
        logoCleared: null,
      },
    });
    expect(decodeCardsSnapshot(encodeCardsSnapshot([card])).cards[0]).toEqual(card);
  });

  it('writes fields in the app’s declaration order, so the bytes can be compared', () => {
    const json = encodeCardsSnapshot([
      cardOf({ id: 'c1', title: 'Cafe', notes: 'n', barcodeValue: '1', barcodeFormat: 'ITF' }),
    ]);
    expect(json).toContain(
      '{"id":"c1","title":"Cafe","notes":"n","barcodeValue":"1","barcodeFormat":"ITF","createdAt":',
    );
  });
});
