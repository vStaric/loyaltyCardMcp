# Shared merge vectors

The merge rules of the shared shopping list and the shared card grid, written once, in
a file neither implementation owns.

- [`shopping-merge.json`](shopping-merge.json) — `ShoppingMerge` (11 vectors)
- [`card-merge.json`](card-merge.json) — `CardMerge` (5 vectors)

## Why these exist

Adding an MCP agent meant a **second** implementation of these semantics
(`PRD-agent-connection.md` §7.1: "That is the honest cost of this feature"). The drift
risk is not hypothetical — `lc-99a`, `lc-39d`, `lc-c3j` and `lc-l85` are four merge
bugs this product already shipped and fixed, every one of them a stamp that did not
move or a comparator that resolved the wrong group of fields. A fresh implementation
re-lives all four unless the rules are a **spec** rather than folklore in one Kotlin
file.

Each vector below is one of those rules, and the ones tagged with a bead id are one of
those bugs. Two devices that disagree about a tiebreak are two devices that disagree
about a shared list, so the vectors also pin the things that look cosmetic: display
order, which author a badge names, and which fields an absent value decodes to.

**These files are the source of truth.** A rule that changes is edited here, once, and
both implementations fail until they agree with it again.

## Who runs them

| Implementation | Harness |
|---|---|
| MCP server (TypeScript) — this repo | `test/mergeVectors.test.ts`, `npm test` |
| Android app (Kotlin) | see [Keeping the app's copy in step](#keeping-the-apps-copy-in-step) |

A harness is deliberately thin: it decodes the vector, calls the merge, and compares.
Anything a harness asserts on its own is a rule the *other* implementation is not being
held to, which is the drift this directory exists to prevent — so assertions belong in
the JSON.

## Rows travel in the wire shape

Slices and expected rows are written as the **snapshot JSON that actually goes inside
an envelope**, not as some test-only shape. Two things follow, and both are the point:

- Each side decodes vectors with the snapshot codec it already ships
  (`decodeShoppingSnapshot` / `decodeCardsSnapshot`; `kotlinx.serialization` configured
  as `HttpTolarApi.defaultJson`). No bespoke parser to get subtly wrong.
- **Absent means default.** The app encodes with `encodeDefaults = false` and
  `explicitNulls = false`, so a null stamp, an `indentLevel` of `0` and an empty list
  are simply not emitted — which is also what a peer running a build older than a
  column emits. A vector therefore states only the fields it is about, and every field
  it omits is asserted to be at its documented default.

Expected rows carry one extra key each, and `ignoreUnknownKeys` means both codecs walk
straight past them: `provenance` on an item, `items` on a section.

### Provenance

Each implementation spells its own provenance type; the vectors use a neutral spelling
and each harness maps it.

```jsonc
"provenance": "own"
"provenance": { "authorUuid": "…", "displayName": "Ada", "connectionKind": "agent" }
```

`displayName` defaults to `null` and `connectionKind` to `"person"` when absent. Which
seat `"own"` names is **not** the same on both sides, and that is deliberate: in the app
it is the user's own device, in the MCP server it is the **agent**. A tool result that
says `own` is saying "this agent put this here", which is the attribution
`PRD-agent-connection` §7.4 makes non-negotiable.

## `shopping-merge.json`

```jsonc
{
  "v": 1,                       // vector-file schema; harnesses reject anything else
  "kind": "shopping-merge",
  "uuids": { "A": "aaaa…", "F": "ffff…" },   // documentation; A sorts below F
  "vectors": [
    {
      "name": "…",              // unique, kebab-case; the test's name on both sides
      "bug": "lc-99a",          // the bead this guards, or null for a rule with no scar
      "why": "…",               // what breaks without it — read this before editing
      "localUuid": "…",         // which slice is "ours"; decides own vs shared
      "slices": [
        {
          "authorUuid": "…",
          "displayName": "Ada", // optional, default null
          "connectionKind": "agent", // optional, default "person"
          "snapshot": { "sections": [ … ], "items": [ … ] }   // wire shape
        }
      ],
      "expected": {
        "sections": [           // in merged display order
          { "id": "…", "title": "…", "createdAt": 0, "sortOrder": 0,
            "items": [ { "id": "…", …, "provenance": "own" } ] }  // in display order
        ],
        "observedByPeers": [ "item-id" ]   // order-insensitive; compared as a set
      }
    }
  ]
}
```

Two things about `expected` that are easy to read the wrong way:

- **Tombstoned rows are still there.** The merge returns the winning observation, and a
  tombstone that won is a row with `clearedDate` set. Filtering it out is the caller's
  active-items view, not the merge's job — so expected sections list it.
- **A removed section is gone.** A section that is tombstoned *and* has nothing live
  left in it on any slice leaves the result entirely, its rows with it (`lc-17q`).

### What each vector pins

| Vector | Guards |
|---|---|
| `uncheck-does-not-move-the-stamp-backwards` | `lc-99a` — an uncheck nulls `checkedOffDate`, so without `stateChangedAt` the stamp falls back to `addedDate` and moves *backwards* |
| `a-rename-wins-from-the-lower-uuid` | `lc-39d` — a text edit moves no date of its own; unstamped it ties and loses on the uuid |
| `a-rename-wins-from-the-higher-uuid` | `lc-39d` from the other side of the tiebreak, so uuid order cannot be what decided it |
| `a-move-arrives-without-the-movers-stale-check-state` | `lc-c3j` — placement is its own comparator, and takes `sortOrder` + `indentLevel` and nothing else |
| `a-section-rename-wins-without-carrying-the-renamers-slot` | `lc-l85` — the title is its own comparator, and does not drag the renamer's `sortOrder` |
| `a-tombstone-beats-a-live-observation` | tombstone-wins, from the *lower* uuid so it is the stamp that did it |
| `one-slot-two-authors-seen-from-the-lower-uuid` | two authors landing different ids on one `sortOrder`; the id settles it |
| `one-slot-two-authors-seen-from-the-higher-uuid` | the same slices merged on the other device — the order must be identical |
| `an-item-whose-section-nobody-holds-is-dropped` | orphans are dropped, but still counted in `observedByPeers` |
| `a-section-removal-is-unioned-and-dated-from-its-first-report` | `lc-17q` — `deletedAt` is unioned not raced, kept at the earliest report, and waits for the section to empty |
| `a-slice-with-no-state-stamp-still-compares-on-its-other-dates` | a peer on a build older than `stateChangedAt` still compares the way it always did |

## `card-merge.json`

`CardMerge` is a read-only deduplicating union, so a vector states its two inputs and
the exact merged sequence.

```jsonc
{
  "v": 1,
  "kind": "card-merge",
  "vectors": [
    {
      "name": "…",
      "why": "…",
      "own": [ { …card wire shape… } ],
      "shared": [ { "authorUuid": "…", "displayName": "Bo",
                    "connectionKind": "person", "cards": [ … ] } ],
      "expected": [ { "card": "card-id", "provenance": "own" } ]   // in merged order
    }
  ]
}
```

An expectation names a card by **id and by whose list it should have come from**, so
the harness compares against that exact input row: a merge that returns the right id
carrying somebody else's fields fails rather than passes. `shared` is deliberately
given out of `authorUuid` order in one vector — the tiebreak is the uuid, not the order
the peers' envelopes happened to open in.

### What each vector pins

| Vector | Guards |
|---|---|
| `own-always-wins-and-the-format-is-part-of-the-code` | own seeds the seen-set; the same digits under two symbologies are two cards |
| `the-value-and-the-format-cannot-be-confused-for-one-another` | a dedup key built by concatenating value and format drops one of two different cards |
| `photo-only-cards-never-deduplicate` | a card with no `barcodeValue` carries no code and can never be a duplicate |
| `among-sharers-the-lowest-uuid-wins-whatever-order-they-arrived-in` | the grid does not depend on fetch order |
| `an-agents-card-is-badged-as-an-agents` | the roster label rides onto every card the sharer contributed (§7.4) |

## Adding or changing a vector

1. Write it here first, with a `why` that says what breaks without it. A vector whose
   `why` is "covers the merge" is a vector nobody can safely delete later.
2. Run it on **both** implementations. A vector only one side runs is a unit test with
   extra steps.
3. If it encodes a bug that has a bead, tag it. The coverage guard in
   `test/mergeVectors.test.ts` asserts the tagged set is still whole, so dropping one is
   possible but has to be deliberate — you edit the guard in the same commit.
4. Prefer a vector that **bites**: mutate the implementation and watch it fail. Every
   vector here was checked that way. Two that did not bite on the first attempt are the
   reason the one-slot vectors hand their slices over with the later-sorting id first.

## Keeping the app's copy in step

The app lives in its own repository (`loyaltyCard`), so it cannot read this directory
directly. Its copy is vendored:

```
loyaltyCardMcp/test-vectors/*.json  →  loyaltyCard/app/src/test/resources/merge-vectors/
```

The Kotlin runner and that copy are tracked as their own bead in the `loyaltyCard` rig.
The contract it has to hold to is the one above: decode with `HttpTolarApi.defaultJson`,
build `AuthorSlice`s, call `ShoppingMerge.merge` / `CardMerge.merge`, compare against
`expected` — and assert nothing else, so both sides stay held to the same file.

Copies drift. Whoever edits a vector here updates the app's copy in the same change; a
vector file that exists on only one side has stopped doing the one job it has.
