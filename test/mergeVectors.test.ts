import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card } from '../src/cards/card.js';
import {
  mergeCards,
  type CardProvenance,
  type MergedCard,
  type SharedCards,
} from '../src/merge/cardMerge.js';
import { connectionKindFromWire } from '../src/sharing/connectInvite.js';
import {
  mergeShoppingSlices,
  OWN,
  type AuthorSlice,
  type ItemProvenance,
  type MergedShoppingList,
} from '../src/shopping/merge.js';
import { decodeShoppingSnapshot } from '../src/shopping/snapshot.js';
import { decodeCardsSnapshot } from '../src/sync/cardSnapshot.js';

/**
 * The shared merge vectors (`test-vectors/`), run against this peer's merge.
 *
 * These are not more unit tests. The vectors are a **language-neutral spec** the app
 * runs too (`test-vectors/README.md`), and this file is only this side's harness for
 * them: adding a second implementation of `ShoppingMerge`/`CardMerge` means every
 * merge bug the app already shipped and fixed — `lc-99a`, `lc-39d`, `lc-c3j`,
 * `lc-l85` — is available to be re-lived here, and the only defence that does not
 * decay is one artefact both implementations are held to.
 *
 * So the assertions live in the JSON, not here. A rule that changes is edited once, in
 * a file neither language owns, and both sides fail until they agree again. Anything
 * this harness asserts on its own — anything phrased in TypeScript — is a rule the app
 * is not being held to, which is the drift the vectors exist to prevent. The one
 * exception is the coverage guard at the bottom, which asserts about the vector FILE
 * rather than about the merge.
 *
 * Rows travel in the wire shape, so both sides decode them with the snapshot codec
 * they already ship rather than a bespoke test parser — and absent-means-default, the
 * convention that lets an old build and a new one share a list, is exercised on the
 * way in.
 */

interface VectorFile<V> {
  readonly v: number;
  readonly kind: string;
  readonly vectors: readonly V[];
}

/** A row as the vector spells it: wire fields, plus whatever keys the codec ignores. */
type Row = Record<string, unknown>;

/** `"own"`, or the author whose observation is expected to have won. */
type WireProvenance =
  | 'own'
  | {
      readonly authorUuid: string;
      readonly displayName?: string | null;
      readonly connectionKind?: string;
    };

interface WireSlice {
  readonly authorUuid: string;
  readonly displayName?: string | null;
  readonly connectionKind?: string;
  readonly snapshot: unknown;
}

interface ShoppingVector {
  readonly name: string;
  readonly bug: string | null;
  readonly why: string;
  readonly localUuid: string;
  readonly slices: readonly WireSlice[];
  readonly expected: {
    readonly sections: readonly (Row & { readonly items: readonly ExpectedItem[] })[];
    readonly observedByPeers: readonly string[];
  };
}

type ExpectedItem = Row & { readonly provenance: WireProvenance };

interface CardVector {
  readonly name: string;
  readonly why: string;
  readonly own: readonly Row[];
  readonly shared: readonly (Omit<WireSlice, 'snapshot'> & { readonly cards: readonly Row[] })[];
  readonly expected: readonly { readonly card: string; readonly provenance: WireProvenance }[];
}

function load<V>(file: string, kind: string): VectorFile<V> {
  const parsed = JSON.parse(
    readFileSync(new URL(`../test-vectors/${file}`, import.meta.url), 'utf8'),
  ) as VectorFile<V>;
  // A vector file that declared a schema or a subject this harness does not implement
  // would otherwise be run under rules it was not written for.
  expect(parsed.v, `${file} schema version`).toBe(1);
  expect(parsed.kind, `${file} subject`).toBe(kind);
  return parsed;
}

const shopping = load<ShoppingVector>('shopping-merge.json', 'shopping-merge');
const cards = load<CardVector>('card-merge.json', 'card-merge');

/** The wire provenance as this implementation spells it for a shopping item. */
function itemProvenance(wire: WireProvenance): ItemProvenance {
  if (wire === 'own') return OWN;
  return {
    kind: 'shared',
    authorUuid: wire.authorUuid,
    displayName: wire.displayName ?? null,
    connectionKind: connectionKindFromWire(wire.connectionKind),
  };
}

/** The same, for a card — where this implementation's own spelling is `sharedBy`. */
function cardProvenance(wire: WireProvenance): CardProvenance {
  if (wire === 'own') return { kind: 'own' };
  return {
    kind: 'sharedBy',
    authorUuid: wire.authorUuid,
    displayName: wire.displayName ?? null,
    connectionKind: connectionKindFromWire(wire.connectionKind),
  };
}

function authorSlice(wire: WireSlice): AuthorSlice {
  return {
    authorUuid: wire.authorUuid,
    displayName: wire.displayName ?? null,
    snapshot: decodeShoppingSnapshot(JSON.stringify(wire.snapshot)),
    connectionKind: connectionKindFromWire(wire.connectionKind),
  };
}

/**
 * The expected list, decoded through the same codec the slices go through — so an
 * expected row states only what it is about and every field it leaves out is asserted
 * to be at its documented default, which is exactly the claim the app's decoder makes.
 */
function expectedList(vector: ShoppingVector): MergedShoppingList {
  const sections = vector.expected.sections.map((raw) => {
    // The extra `items` key on a section, and `provenance` on an item, are keys the
    // codec ignores — the same tolerance that lets a peer on a newer build share a list.
    const decoded = decodeShoppingSnapshot(JSON.stringify({ sections: [raw], items: raw.items }));
    return {
      section: decoded.sections[0]!,
      items: decoded.items.map((item, i) => ({
        item,
        provenance: itemProvenance(raw.items[i]!.provenance),
      })),
    };
  });
  return { sections, observedByPeers: new Set(vector.expected.observedByPeers) };
}

function decodeCards(rows: readonly Row[]): readonly Card[] {
  return decodeCardsSnapshot(JSON.stringify({ cards: rows })).cards;
}

/**
 * The one card `id` names in `where`'s list. A vector that names an id its own input
 * does not hold, or holds twice, is a broken vector rather than a failing merge, and
 * says so.
 */
function theCard(list: readonly Card[], id: string, where: string): Card {
  const hits = list.filter((card) => card.id === id);
  expect(hits, `vector expects exactly one card "${id}" in ${where}`).toHaveLength(1);
  return hits[0]!;
}

describe('shopping-merge vectors', () => {
  it.each(shopping.vectors.map((vector) => [vector.name, vector] as const))('%s', (_name, v) => {
    expect(mergeShoppingSlices(v.slices.map(authorSlice), v.localUuid)).toEqual(expectedList(v));
  });
});

describe('card-merge vectors', () => {
  it.each(cards.vectors.map((vector) => [vector.name, vector] as const))('%s', (_name, v) => {
    const own = decodeCards(v.own);
    const shared: readonly SharedCards[] = v.shared.map((set) => ({
      authorUuid: set.authorUuid,
      displayName: set.displayName ?? null,
      kind: connectionKindFromWire(set.connectionKind),
      cards: decodeCards(set.cards),
    }));

    // Each expectation names a card by id AND by whose list it should have come from,
    // so the comparison is against that exact input row: a merge that returned the
    // right id carrying somebody else's fields fails here rather than passing.
    const expected: readonly MergedCard[] = v.expected.map((want) => {
      if (want.provenance === 'own') {
        return { card: theCard(own, want.card, 'own'), provenance: cardProvenance('own') };
      }
      const uuid = want.provenance.authorUuid;
      const set = shared.find((s) => s.authorUuid === uuid);
      expect(set, `vector expects a shared set for ${uuid}`).toBeDefined();
      return {
        card: theCard(set!.cards, want.card, uuid),
        provenance: cardProvenance(want.provenance),
      };
    });

    expect(mergeCards(own, shared)).toEqual(expected);
  });
});

/**
 * The vectors the bead names as the floor (`lcm-bgp`), each one a merge bug this
 * codebase already shipped and fixed. Deleting one is allowed — the rule it guards may
 * genuinely have gone — but only deliberately, by editing this list in the same commit.
 */
describe('coverage', () => {
  it('still carries a vector for every merge bug the app has already fixed', () => {
    const bugs = new Set(shopping.vectors.map((v) => v.bug).filter((bug) => bug !== null));
    expect([...bugs].sort()).toEqual(['lc-17q', 'lc-39d', 'lc-99a', 'lc-c3j', 'lc-l85']);
  });

  it('names every vector uniquely and says what each is for', () => {
    const named = [...shopping.vectors, ...cards.vectors];
    expect(new Set(named.map((v) => v.name)).size).toBe(named.length);
    for (const vector of named) {
      expect(vector.why.length, `${vector.name} explains itself`).toBeGreaterThan(0);
    }
  });
});
