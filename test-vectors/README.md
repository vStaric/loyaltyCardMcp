# Shared test vectors

The seams where two implementations of this product have to agree, written once, in
files neither implementation owns.

| File | Seam | |
|---|---|---|
| [`shopping-merge.json`](shopping-merge.json) | `ShoppingMerge` | 11 vectors |
| [`card-merge.json`](card-merge.json) | `CardMerge` | 5 vectors |
| [`envelope-crypto.json`](envelope-crypto.json) | `EnvelopeCrypto` + `IdentityDeriver` | 3 identities, 24 vectors |

The two families are here for the same reason but they are not the same kind of file,
and the difference decides how you edit them:

- The **merge** vectors are a *specification*. Each one states a rule in the abstract;
  if the rule changes, you edit the vector and both sides fail until they agree again.
- The **envelope crypto** vectors are *fixed artefacts*. Each one is a ciphertext that
  was produced once and written down. Regenerating one does not update it — it replaces
  the external answer with whatever the implementation currently does, which is the
  entire thing the file exists to prevent. See
  [Do not regenerate the crypto vectors](#do-not-regenerate-the-crypto-vectors).

# Part one: the merge vectors

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

The envelope crypto vectors are run by `test/envelopeVectors.test.ts` on this side, under
the same rules.

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

# Part two: the envelope crypto vectors

## Why these exist (`lcm-c46`)

The envelope has two seams and only one of them was ever cross-pinned.

The **signing** seam — `EnvelopeSigning.signedBytes`, the layout an author signs — is
pinned three ways, against fixed literals, in all three repos. The **encryption** seam,
the one that actually carries user data from one client to another, was pinned nowhere.

Round-trip tests cannot see the break. If the app's AEAD framing, key wrapping or
identity derivation drifts from the MCP server's by one byte, both sides still seal and
open their own envelopes perfectly, and every test in every repo stays green. The server
never decrypts — that is the product's central privacy claim — so **the one component
that sees both clients is blind to exactly this class by design.** There is no CI signal
and no server signal. The defect surfaces as a real Android user unable to open a list
sealed on the other client, or as an account that restores from the right recovery
phrase into the wrong uuid.

What closes it is the same move as the signing vectors, one layer down: a fixed
`(ciphertext + key map + recipient secret) → plaintext` triple that a *second*
implementation has to reproduce. An implementation that cannot open these envelopes has
already drifted, and says so at `npm test` rather than in a support thread.

## `envelope-crypto.json`

```jsonc
{
  "v": 1,                        // vector-file schema; harnesses reject anything else
  "kind": "envelope-crypto",
  "identities": { "A": { … }, "B": { … }, "C": { … } },
  "open":      [ … ],  // fixed envelope + recipient  → these exact plaintext bytes
  "openFails": [ … ],  // fixed envelope + recipient  → refused, in this exact category
  "sign":      [ … ],  // fixed body + signer         → this exact signature
  "verify":    [ … ]   // fixed envelope + author key → true or false
}
```

### `identities`

Three peers, each derived from a **canonical BIP-39 mnemonic** every implementation of
BIP-39 already agrees on, so a failure here is this product's derivation and not the
word list.

| | role | uuid |
|---|---|---|
| `A` | author — seals, signs, and is a recipient of its own resources | `220e05b1-…` |
| `B` | peer — a second recipient the content key is wrapped for | `5b12538c-…` |
| `C` | stranger — holds keys, was never made a recipient of anything | `36c0cb4c-…` |

Each entry carries the whole chain: `mnemonic` → `bip39Seed` → `uuid`, `ed25519Seed`,
`x25519Seed`, and both keypairs in full. All byte fields are lowercase hex; everything
inside an envelope is standard padded base64, matching the server's `java.util.Base64`.

Two things that look redundant and are not:

- **The public keys are pinned, not just the sub-seeds.** A published `sign_key` /
  `enc_key` is what every other peer wraps to; two libsodium builds agreeing is an
  assumption worth an assertion rather than a comment.
- **The secret keys are in the file.** They are how a harness opens an envelope without
  first deriving anything, which keeps a decrypt failure from being ambiguous between
  "the wrapping drifted" and "the derivation drifted". The identity vectors pin the
  derivation separately, so a real drift names itself. These are published test keys and
  guard nothing.

### `open` — the vectors the bead is about

```jsonc
{
  "name": "…",                   // unique, kebab-case; the test's name on both sides
  "why": "…",                    // what breaks without it — read this before editing
  "recipient": "A",              // whose x25519 secret opens it
  "envelope": { "data": { "iv": …, "ciphertext": …, "tag": … },
                "keys": { "<uuid>": "<wrapped cek>" },
                "signature": { "by": …, "ver": …, "sig": … } },
  "plaintextBase64": "…"         // the exact bytes it must produce
}
```

| Vector | Pins |
|---|---|
| `a-two-recipient-shopping-list-opens-for-its-author` | the seam itself: fixed ciphertext + key map + recipient secret → fixed plaintext |
| `the-same-envelope-opens-for-the-second-recipient` | each sealed box is addressed to its own recipient and wraps the *same* CEK |
| `a-cards-blob-opens-for-its-single-recipient` | a one-entry key map, so the unwrap cannot be reading a neighbouring entry |
| `an-empty-payload-opens-to-zero-bytes` | a tag-only body; catches an implementation that treats empty ciphertext as absent |
| `every-byte-value-survives-the-payload-path` | bytes `0x00..0xFF`; catches a payload pushed through a `String` — any charset mangles `0x80..0xFF` and truncates at the NUL |
| `non-ascii-item-names-open-unchanged` | real list text: diacritics, a multi-byte dash, an astral-plane emoji |

`plaintextBase64` rather than a readable string on purpose: two of these payloads are
not text at all, and one base64 field that always means "bytes" is one fewer place for
the two sides to disagree about encoding.

### `openFails` — and why "does not open" is too weak

Each carries a `failure` category, which is part of the contract:

| `failure` | means |
|---|---|
| `no-wrapped-key` | this uuid is not in the key map — never shared, as opposed to broken |
| `malformed-base64` | a field is not decodable — a bad envelope, as opposed to a bad key |
| `authentication` | the sealed box or the AEAD tag refused — the ciphertext is not what its author sealed |

Each implementation spells its own exception type and maps it, the same arrangement the
merge vectors use for provenance. The category is asserted rather than just "it threw"
because the weaker claim does not hold both sides to the same behaviour: Node's base64
decoder silently skips characters it does not recognise while the JVM's throws, so a
permissive decoder *also* fails to open a malformed envelope — as an authentication
error. The same bad write then reads as "this envelope is corrupt" on one client and
"decryption failed" on the other, and whoever debugs it goes looking at keys instead of
at the field that is actually broken.

| Vector | Pins |
|---|---|
| `a-stranger-holds-no-wrapped-key` | granting the list and not the cards means *cannot read*, not *is not shown* (`PRD-agent-connection` §9) |
| `a-stranger-cannot-relabel-someone-elses-wrapped-key` | the key map is not an access list the reader can edit |
| `a-flipped-tag-byte-does-not-open` | the Poly1305 tag; a side that decrypts before authenticating passes every other vector here |
| `a-flipped-ciphertext-byte-does-not-open` | the same, from the other side — XChaCha20 is a stream cipher, so an unauthenticated open returns a plaintext wrong in exactly that byte |
| `a-wrapped-key-that-is-not-base64-is-rejected` | strict decoding, as the category above |
| `a-nonce-that-is-not-base64-is-rejected` | the same permissiveness one field over |

### `sign` and `verify`

Ed25519 detached signatures are deterministic, so a `sign` vector can pin the signed-byte
layout, the recipient ordering **and** the key derivation as a single literal — the
signing seam end to end, rather than at the bytes-only boundary `envelopeSigning.test.ts`
already covers.

| Vector | Pins |
|---|---|
| `signing-a-two-recipient-envelope-produces-exactly-this-signature` | the whole chain, as one base64 literal |
| `the-recipient-map-is-sorted-before-signing-not-taken-in-insertion-order` | the same recipients in the other order sign identically; a side that iterates its own map order gets `bad_signature`, which reads like a key problem |
| `an-empty-recipient-map-still-signs-the-header` | the recipient block is absent, not an empty line |

`verify` states the resource the signature is being checked against and the expected
boolean. One vector is `true` — without it the negatives could all pass by verifying
nothing — and the rest are the replays the signed header exists to stop: another
`resourceType`, another `resourceId`, a bumped `ver`, a recipient grafted in after
signing, a tampered ciphertext, a stranger's key. Two more pin that an unsigned envelope
and a garbled signature are *unverified* rather than exceptions: both arrive off the wire
from anyone, and a malformed peer write must not crash a sync pass.

## Do not regenerate the crypto vectors

`encrypt` picks a random content key and nonce, and `crypto_box_seal` picks a random
ephemeral keypair, so these envelopes cannot be recomputed — which is the point. They
were produced once, by the MCP server's `EnvelopeCrypto`, and committed.

Regenerating one on the side that is failing does not fix anything: it overwrites the
external answer with whatever that side currently does, and the file quietly stops being
a cross-check at all. **A failing crypto vector means one of the implementations moved.**
Find out which, and fix the implementation.

Adding a vector is fine, and is done by sealing a new envelope with either
implementation and pasting the result in with a `why`. Prove it bites the same way as
any other vector here.

# Part three: keeping every copy in step

## Adding or changing a merge vector

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

## Adding or changing a crypto vector

Same rules, with one substitution: a crypto vector cannot be *changed*, only added or
deleted (see [Do not regenerate the crypto vectors](#do-not-regenerate-the-crypto-vectors)).
Step 4 still applies, and the seven mutations the current set was checked against are
worth repeating on anything new — tag-before-ciphertext in the decrypt concat, recipients
signed in insertion order, a bumped HKDF salt, a permissive base64 decoder, unforced UUID
version bits, the X25519 sub-seed derived under the Ed25519 label, and a dropped
`resourceId` line. Each of those is a plausible port slip, and each fails a different
group of vectors.

## Keeping the app's copy in step

The app lives in its own repository (`loyaltyCard`), so it cannot read this directory
directly. Its copies are vendored:

```
loyaltyCardMcp/test-vectors/{shopping,card}-merge.json
    →  loyaltyCard/app/src/test/resources/merge-vectors/
loyaltyCardMcp/test-vectors/envelope-crypto.json
    →  loyaltyCard/app/src/test/resources/crypto-vectors/
```

Each runner and its copy are tracked as their own bead in the `loyaltyCard` rig. The
contract is the one stated above for each family:

- **merge** — decode with `HttpTolarApi.defaultJson`, build `AuthorSlice`s, call
  `ShoppingMerge.merge` / `CardMerge.merge`, compare against `expected`.
- **envelope crypto** — build a `SodiumKeyPair` from the identity's hex, call
  `EnvelopeCrypto.decrypt` / `sign` / `verify`, compare against the vector, and map each
  `failure` category onto the `CryptoException` the app actually throws.

…and assert nothing else, so both sides stay held to the same file.

One placement note that decides whether this works at all: the crypto runner belongs in
`app/src/test/` — a **JVM unit test**, in `./gradlew test`. The app's existing envelope
crypto tests live in `androidTest/`, which needs a device or an emulator, and there is no
device in CI. A vector suite that only runs when somebody plugs a phone in is not a gate.
If a dependency forces it onto a device, that is worth knowing and worth writing down
here.

The backend (`loyaltyCardBe`) never decrypts, so `open` and `openFails` do not apply to
it — but `sign` and `verify` do, and it is a third independent implementation of exactly
that. Its `EnvelopeSignatureTest` already pins the byte layout; running these vectors
would pin the signature itself.

Copies drift. Whoever edits a vector here updates the other copies in the same change; a
vector file that exists on only one side has stopped doing the one job it has.
