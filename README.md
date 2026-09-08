# loyaltyCardMcp

The Tolar **MCP server** — exposes a Tolar account to an AI agent over the Model
Context Protocol, so the agent can be added as an ordinary connection alongside
people.

## What this is, and what it is not

This is a **Tolar client**, not a backend feature. It speaks the existing REST API
with the existing envelope crypto:

- **no new backend endpoint, no backend change**
- the Tolar server learns nothing it does not already see — one more account
  publishing envelopes it cannot read

It runs as its own process. Where it runs (a user's laptop or a hosted box) is
**not** a fork in the architecture — the same peer, the same code — but it *is* a
fork in what is true about the consent disclosure, so the connect flow records it.

## The honest cost

This is a **second implementation of the merge semantics**. It must port:

- BIP-39 → identity derivation
- envelope seal / open / verify
- the REST client and per-request signer
- `ShoppingMerge` and `CardMerge`
- the write-stamp discipline

The Android app already shipped four separate merge bugs (lc-99a, lc-39d, lc-c3j,
lc-l85). Two implementations of the same semantics will drift unless shared test
vectors keep them honest — that is a first-class deliverable, not a nicety.

## What an agent can and cannot do

Deliberately identical to what a **human peer** can do:

| | shopping list | cards |
|---|---|---|
| read | ✅ | ✅ |
| add | ✅ | ✅ (lands in the agent's own list, badged) |
| edit / delete its own | ✅ | ✅ |
| edit / delete the user's | ✅ (per-author slices) | ❌ not permitted, not possible |

The card asymmetry is not an agent limitation — a human peer cannot edit your cards
either. An agent is neither more nor less capable than a person, which is the whole
point of the connection model.

## The peer core

Shipped in `lcm-au3`: the parts of the app this server needs in order to be a peer at
all.

| | ported from |
|---|---|
| BIP-39 codec | `crypto/Bip39.kt` |
| seed → identity derivation | `crypto/IdentityDeriver.kt`, `Identity.kt` |
| envelope seal / open / sign / verify | `crypto/EnvelopeCrypto.kt`, `Envelope.kt` |
| REST client + per-request signer | `sync/HttpTolarApi.kt`, `RequestSigner.kt`, `Wire.kt` |
| invite, fingerprint, share code | `sync/sharing/{ConnectInvite,KeyFingerprint,ShareCode}.kt` |

Not ported, and deliberately: `PUT /api/device` and `POST /api/push`. Those are the
FCM push-token registry and its fan-out, which exist to wake a phone that is not
running. This peer is a process that either runs or does not, and polls while it is up.

### Keeping the two implementations honest

Five formats have to agree byte-for-byte with the app and the backend, and none of them
fails loudly when they stop agreeing — a drift mints a *different account*, produces
envelopes the server answers with `bad_signature`, or hands the other client a payload
it cannot open. Each is pinned by known answers rather than by round-trip tests, which
cannot see this class of break at all:

- **identity derivation** — vectors computed on the JVM, through the same
  `javax.crypto` HMAC-SHA512 the app runs on (`test/identityDeriver.test.ts`)
- **envelope signed bytes** — the exact vectors the backend's `EnvelopeSignatureTest`
  and the app's `EnvelopeSigningTest` pin (`test/envelopeSigning.test.ts`)
- **per-request canonical message** — likewise, from `CanonicalMessageTest`
  (`test/canonicalMessage.test.ts`)
- **share code payload** — a code emitted by the app's `ShareCode.encode`,
  transliterated onto the JVM (`test/sharing.test.ts`)
- **envelope encryption** — a fixed ciphertext, key map and recipient secret that must
  open to fixed plaintext (`test/envelopeVectors.test.ts`) — see below

The card snapshot encoder writes its fields in the app's declaration order and omits
defaults the way `kotlinx` does, so the two implementations' bytes can be compared
rather than merely re-parsed.

The **merge** is pinned the same way, but by a spec rather than by constants — see
below.

### The seam that carries the data, not just the one that signs it (`lcm-c46`)

"Envelope signed bytes" above is the *signing* seam: it pins what an author signs, and
the server checks the same thing on every write, so a drift there is caught three ways.
The **encryption** seam is the one that actually carries user data between clients, and
the server never decrypts — by design it cannot see a break in it at all.

Round-trip tests cannot either. If this implementation's AEAD framing, key wrapping or
identity derivation drifts from the app's, both sides still open their own envelopes
perfectly and every suite in all three repos stays green; the defect surfaces as an
Android user who cannot open a list this agent sealed.

So the encryption seam is pinned the only way that works across implementations: fixed
envelopes in [`test-vectors/envelope-crypto.json`](test-vectors/README.md#envelope-cryptojson),
written down once, with the plaintext each must produce and the recipient secret that
must produce it. A second implementation that cannot reproduce them has already drifted.
The file also pins seed → uuid and public keys, and — Ed25519 being deterministic —
literal signatures, so the whole chain from recovery phrase to published envelope has
an external answer to compare against.

### The merge rules are a spec, not folklore (`lcm-bgp`)

`ShoppingMerge` and `CardMerge` are the two ports with no byte-level answer to compare
against: they are behaviour, and behaviour drifts quietly. So the rules live in
[`test-vectors/`](test-vectors/README.md) as language-neutral JSON — input slices plus
a `localUuid`, and the exact merged output — and **both** implementations run them.

Seventeen vectors, one per rule, including one for each merge bug the app already shipped
and fixed:

| | |
|---|---|
| `lc-99a` | an uncheck must not move the content stamp backwards |
| `lc-39d` | a rename wins from either side of the uuid tiebreak |
| `lc-c3j` | a move carries `sortOrder` and `indentLevel` and nothing else |
| `lc-l85` | a section rename wins without dragging the renamer's slot |
| `lc-17q` | a section removal is unioned, dated from its first report, and waits for the section to empty |

Rows are written in the wire shape, so each side decodes them with the snapshot codec
it already ships and "absent means default" is exercised on the way in. This side's
harness is `test/mergeVectors.test.ts`; it decodes, merges, compares, and asserts
nothing of its own — anything it asserted alone would be a rule the app is not held to,
which is the drift the vectors exist to prevent.

Every vector was checked by mutating the implementation and watching it fail — on both
implementations, because a vector that cannot fail on one side has quietly become a
single-side unit test (`lc-3of`). That is why the shared-slot vectors put three rows on
each of two slots and hand them over in the exact reverse of the order expected back.

### Where the agent's keys live, and what protects them

The agent generates its own BIP-39 seed and derives its own uuid and keypairs from it.
It is never handed the user's (design §3.2). The phrase is stored in the config
directory — `TOLAR_MCP_HOME`, else `$XDG_CONFIG_HOME/tolar-mcp` — as `identity.json`,
mode `0600` in a `0700` directory.

**That is the whole protection.** The app seals its entropy with a hardware-backed
Android Keystore key; there is no equivalent on a laptop or a hosted box, so anyone who
can read that file is this agent. It is a real reduction relative to the phone, and it
is why the agent holds its own identity rather than the user's: the blast radius is
what the user shared with this agent, and one eviction in the app ends it.

## Build and run

```bash
npm install
npm run build        # tsc → dist/
npm test             # vitest
npm run lint         # eslint
npm run format       # prettier --check
```

Pairing. Design §7.2 prefers the long code / QR over the short pairing code: the short
code's fingerprint arrives from the server in the same breath as the uuid it is checked
against, so it is a self-consistency test rather than a pin, and both ends here are the
user's own.

```bash
export TOLAR_API_URL=https://your-tolar-backend.example
npx tolar-mcp pair              # publishes the user row, prints QR + code + safety number
npx tolar-mcp connections       # who this agent shares with, and who is asking
npx tolar-mcp accept 7          # accept a request — admission to the household
npx tolar-mcp decline 7         # refuse one: hide it here, and tell the requester
npx tolar-mcp leave             # walk this agent out of every household it is in
npx tolar-mcp serve             # the MCP server, on stdio — what a host launches
npx tolar-mcp status            # account uuid and config location
npx tolar-mcp export-phrase     # the recovery phrase — the complete backup
npx tolar-mcp import-phrase "…" # adopt an identity on another host
```

## The card tools (`lcm-ffs`)

`serve` exposes six tools: `list_cards`, `get_card`, `get_card_photo`, `add_card`,
`update_card`, `delete_card`. Three properties are the deliverable, and each has tests
naming it.

**The ownership refusal is explicit.** `cards/{uuid}` is a single blob signed by one
author, so an agent editing the user's card is not withheld — it is impossible, the
server would reject the signature. `update_card` and `delete_card` on somebody else's
card fail with *"cards belong to the account that created them"*, naming the owner, and
every card in a result carries `editableByThisAgent` so a caller never has to infer it.
An agent that reported an edit which did not happen would be worse than one that refuses.

**An ungranted resource is a refusal, not an empty list.** A peer whose cards envelope
carries no content key wrapped to this agent has not given this agent its cards. That
surfaces as a named `not_granted` entry with the sentence to say — never as "you have no
cards", which would be a lie about the user's data. The other reasons (`not_published`,
`not_verified`, `undecryptable`, `malformed`, `unreachable`) stay distinguishable for the
same reason.

This is the **inbound** direction, and it is the only one left with an answer of its own:
what a peer seals to this agent is decided on their device and learnt here only from
whether the envelope opens. Outbound, this agent no longer narrows anything — see
[Everyone in the household sees everything](#everyone-in-the-household-sees-everything-lcm-hfd).

**Writes never rest on a degraded read.** The cards blob is published whole, so the write
path re-reads it first — and a read this peer cannot verify or open throws rather than
yielding an empty list, because "no cards" followed by a publish is how you erase them all.

## Card photos (`lcm-gll`)

Photos travel as content-addressed blobs: a card carries a `BlobPointer` — the SHA-256 of
the *ciphertext*, plus the base64 AES key — and the bytes sit in the server's blob store
in the app's `ImageCipher` format (`TIC1` magic, IV length, IV, AES/GCM ciphertext and
tag). `get_card_photo` takes a card id and a slot (`front`, `back`, `logo`), fetches the
blob, checks the bytes really are at the address the card named, opens them, sniffs the
media type from the bytes themselves, and returns MCP **image** content. `src/images/`
is the port; it has only the open half, because this peer has no camera and carries an
author's pointers through a re-publish verbatim rather than re-encrypting anything.

This grants nothing new: the key rides inside the card snapshot, so a photo is readable
exactly when the card naming it is.

The format is pinned in `test/imageCipher.test.ts` against blobs produced by a **JVM**
running the app's own `AES/GCM/NoPadding` — a port whose only test is itself agrees with
itself and with nothing else.

The absences are results, not errors, and they stay distinct: `no_photo` (with the lc-mr9
tombstone distinguishing "the author removed it" from "the author never spoke for this
slot"), `not_stored` (the card is published, the blob is not up yet — an ordinary minute
in a healthy account), and `too_large`. Bytes that are *not* at the address requested, or
that the card's own key will not open, throw instead: an integrity failure must not reach
a user as "you have no photo".

The size ceiling defaults to 2 MiB — the backend's own per-blob limit
(`BlobConfig.DEFAULT_MAX_BYTES`), so no photo a phone was allowed to upload is refused as
"too large", which a user would read as damage to their own data. A host that must budget
its context lowers it with `TOLAR_MCP_MAX_PHOTO_BYTES`, and the refusal names that
variable.

## The shopping-list tools (`lcm-a5e`)

`serve` also exposes `list_shopping` and the eight writes: `add_items`, `rename_item`,
`set_checked`, `set_footnote`, `move_item`, `create_section`, `rename_section`,
`remove_item`.

This is the resource where "the same as a person" means *everything*. The list is already
multi-writer: each author publishes their own slice at
`shoppinglist/{listId}::{authorUuid}` and every device reconstructs the list by merging
them, so the agent editing the user's item is one more author publishing one more
observation — not a privilege, and not the cards' asymmetry. What it still cannot do is
write another account's resource; the server verifies the signature inside the envelope.

There is deliberately **no `remove_section`**. A section's tombstone only takes effect once
the section is empty on *every* slice, and a peer's live items are not this agent's to
destroy, so the honest removal from here is to tombstone the items.

### The stamp column is the whole risk

Every rule below is a bug the Android app already shipped and fixed, and not one of them
fails loudly: the write succeeds, the tool reports success, and the phone silently reverts
it on the next merge. `src/shopping/writer.ts` is where they live, and
`test/shoppingWriter.test.ts` checks each one twice — on the field, and *through the merge*
against a peer's stale observation, which is the shape all four bugs actually took. A field
assertion alone would have caught none of them: the field was always written; the stamp
that let it win was not.

| write | stamp it moves | the bug without it |
|---|---|---|
| add | `addedDate` | — |
| rename, footnote | `stateChangedAt` | `lc-39d` — ties with a stale observation, loses on the uuid tiebreak, the typing reverts |
| check | `checkedOffDate` + `stateChangedAt` | — |
| uncheck | `stateChangedAt` | `lc-99a` — the stamp moves *backwards* and the uncheck snaps back |
| move, indent | `layoutChangedAt`, never the content stamp | `lc-c3j` — one move drags a whole section's stale check-states with it |
| rename section | `titleChangedAt`, never the section representative | `lc-l85` — the rename carries the renamer's `sortOrder` |
| remove | `clearedDate` + `stateChangedAt`, never a row delete | the peers' live observations are left unopposed and the item returns |

Two further rules, both from the app: **adopt the section when writing into it**
(`lc-ing`), and **observe a peer's item under the peer's own id** (`lc-99a`) — an
observation is a second opinion about an existing element, so it must collide with their
row in the merge's union-by-id rather than fork a second row beside it.

`ShoppingMerge` is ported alongside them (`src/shopping/merge.ts`), checked against the
cases the app's own `ShoppingMergeTest` pins; `lcm-bgp` is where the two implementations'
shared vectors go.

### One divergence, deliberate

The app renumbers a dragged section densely over **its own** rows
(`TodoReorder.resortedItems`). This agent typically holds one row in a section full of
somebody else's, where a dense number lands on an occupied slot and the merge's id
tiebreak decides which side of it the row falls on. So `move_item` writes one row and
picks its slot relative to the merged neighbours it must land between — slots are integers
and need not start at zero or be contiguous.

Adopting the peer's rows in order to renumber them is the thing not to do: a verbatim copy
of a peer's row carries an *identical* content stamp, so the tiebreak falls to the greater
uuid — and where that is ours, reordering a section would re-attribute the user's own items
to the agent.

### Who this agent shares with is not a tool

Pairing, accepting and revoking are CLI commands, deliberately. `POST /api/requestShare`
is permissionless — anyone who learns this agent's uuid can queue a request — and
accepting one wraps this agent's content keys to the requester. An agent that could
accept its own connections would be one prompt-injection away from sharing with whoever
asked. The model gets to use a grant; only the operator gets to make one, and only the
operator can do the step that carries the trust: comparing the safety number against the
one the app shows.

What the *user* shares back is set on their accept screen, not here. This agent learns it
only by whether their envelope carries a key it can open.

### Everyone in the household sees everything (`lcm-hfd`)

**Household membership implies every scope.** Overseer decision, 2026-09-08. Everyone
this agent is connected to — the person who ran the connect flow, and every peer learnt
through their grant document — is sealed every resource it publishes: all cards, all
shopping lists, barcode values included. What a member is sealed does not vary by member,
so there is no per-connection grant left to record, to display, or to choose. `accept`
takes no `--scopes`, and refuses the flag rather than quietly widening past a narrowing
the operator asked for.

This supersedes a real control. `lc-chp` let a connection be granted the shopping list
and not the cards, and `lcm-8lm` had an indirect peer inherit the scopes of the
connection it was learnt through, precisely so that an account nobody approved could not
collect the barcode values by way of a default. The decision was taken with that cost
stated: with no accept step on this side, scope narrowing was the only control a member
had over a peer somebody else invited, and collapsing it leaves them none. The answer was
that this is expected and correct. It is the specified behaviour, not an oversight to
mitigate around. It does raise what rides on the one control that is left: eviction is a
member's to exercise and never this agent's (`lcm-9m7`).

A roster written before this — narrowed entries, and the deliberate "connected, sharing
nothing" of an empty grant — widens on load. Nothing in this version can narrow anyone,
and one member quietly reading less than another would be a state no operator could get
out of.

Two things this did **not** touch, and neither may travel with it:

- **Verification and key pinning are unchanged.** This widens who receives a content key.
  It does not change who can forge an envelope: an indirect peer's writes are still
  verified against the key pinned for them, and a forgery signed by anyone else is
  refused by name.
- **A peer still cannot set what it is sealed.** The `scopes` a grant document carries
  are not read, and there is nowhere left to put them. Membership is implied by this
  agent's own roster and asserted by nobody — the property `lcm-8lm` was careful about
  when scopes varied, and which matters more now that they do not.

Enforcement stays in one place: the recipient list built at seal time, in
`cardService.publish` and `shoppingService.publish`. Building that list is the same act
as handing out keys, so an account left out of the wrap holds nothing the ciphertext will
open for, whatever any listing says. It filtered by scope; it now reads the household
membership fresh at every publish, which is where an eviction takes effect.

### Peers of peers (`lcm-8lm`)

A roster built only from accepted requests holds exactly the accounts that ran the
connect flow. That is one account, and the space is not one account: two people share a
list, one of them adds the agent, and every envelope the agent publishes is wrapped to
that one seat. The second person sees nothing the agent writes and cannot tell the agent
is there at all — and not as a display bug. No key exists anywhere that would open the
ciphertext for them.

So each connection's grant document — `share/{uuid}`, the record of who *they* share
with — is read during sync, and the accounts it names are merged into this agent's
roster as **indirect** connections, pinned to the public keys that document carried. The
publish path then picks them up as recipients with no change of its own: the recipient
map written at seal time is the only thing that has ever decided visibility.

The document is believed on exactly the terms a peer's card list is: fetched, verified
against the signing key **pinned in our roster** rather than the server's live answer,
and opened with the content key wrapped to us. A document that fails any of those is
reported and not used, so a server that swapped a peer's key cannot hand us a roster it
wrote and name whichever account it likes as a recipient of our cards.

Three decisions are worth stating rather than leaving to be inferred:

**An indirect peer is sealed everything, like every other member.** This one was
answered twice. `lcm-8lm` gave it inheritance — B gets what A gets and never more —
against the alternative of defaulting to every scope and handing the barcode values to an
account nobody approved. `lcm-hfd` then collapsed the scopes altogether, so inheritance
has nothing left to carry and the alternative it was guarding against is the rule:
membership is the grant, and an indirect peer is a member. The other two decisions below
are untouched by that, and they are what keeps a peer from turning "everyone sees
everything" into "anyone can join".

**One hop.** Only direct connections' documents are read. Following an indirect peer's
document too would let a single vouched-for account extend this agent's roster by itself,
without bound and without anything an operator could point at.

**Revoking a connection removes everything learned through it.** An indirect peer is in
the roster because a direct connection vouched for it; tear up that grant and leaving the
peer behind would have the agent go on sealing to an account whose only claim was the
grant just withdrawn. A peer that some *other* connection also names comes back on the
next pass, attributed to that one — which is the right answer and arrives by the same
visible route as any other indirect entry.

`tolar-mcp connections` marks indirect entries and names the connection each arrived
through, because an indirect peer is an account the operator did not personally approve
and the one thing they must not have to guess at — all the more so now that it reads the
barcode values. It says that plainly, once, for the household, rather than printing a
per-account grant that no longer varies. Their own inbound request still shows as
waiting, too: being vouched for is not the operator comparing a safety number, and
accepting it is what turns the entry into a direct connection — one row that upgrades,
never a second.

### The agent cannot evict anybody (`lcm-9m7`)

People and agents are invited into a shared **household**. Everyone sees everyone, and
any member may kick a person or an agent out. **The agent is not one of the parties that
may** — and until this change it was: `tolar-mcp revoke <uuid>` dropped any account in
the roster and cascade-dropped everyone the agent knew only through them.

So the verb is gone. Not renamed, not moved behind a flag: there is no command, no MCP
tool and no method on `ConnectionManager` that names an account to remove. `revoke` is
still recognised by the CLI only so that typing it prints the reason rather than
"unknown command", which would read as a broken install.

**What is kept is leaving.** `tolar-mcp leave` walks this agent out of every household it
is in. It takes no argument, and that is the design rather than an omission — an argument
is exactly the shape of the capability being removed, so there is no expression in this
program that could be pointed at somebody else. Leaving needs nobody's permission, and it
is the operator's local off switch if a household turns out to be the wrong one.

The cost is stated rather than hidden: an operator who wants out of one household but not
another leaves both and accepts the one they are keeping again. That is the trade for
having no verb that could ever be aimed at another member.

Leaving publishes a final grant document — no connections, and one eviction naming this
agent — sealed to the members being left, so their app can drop a member that has gone
rather than keep one that has merely gone quiet. That half is best-effort, exactly as in
`decline`: the local half cannot fail and happens whatever the network does, because an
off switch that needs a server is not one. The CLI says which of the two happened.

**The other half is obedience.** An eviction rides the grant document, which is already
signed and already sealed to every member, so it needs no new resource and no new
endpoint. When a member declares a uuid out:

- the account leaves this agent's roster, and everything learned through it goes with it;
- the next publish does not seal to it — the recipient map is rebuilt on every publish, so
  the content key rotates away by the ordinary path;
- an introducer whose own document still lists that account cannot bring it back. Every
  direct connection's document is read first and the evictions are **subtracted last**, so
  which document happened to be fetched first does not decide the answer;
- an eviction naming *this agent* is honoured too: it leaves that household, publishes
  nothing further to it, and `tolar-mcp connections` says so at the top rather than
  printing a roster that looks connected.

Four decisions are worth stating rather than leaving to be inferred.

**The tombstone never expires.** It is persisted in `roster.json` rather than recomputed
each pass, because the document that carried it may be unreachable on the next one, and an
eviction forgotten the first time the network is down would resurrect the account it
removed. Nothing garbage-collects it. The list grows with the number of accounts a
household has ever removed, which is small, and the alternative — an eviction that expires
— hands a still-listing introducer a window in which to re-derive the evicted peer.

**A later admission outranks it, and that is how a re-invite works.** Kicked out is not
banned for life. An eviction at time `T` removes an entry unless the admission it rests on
is later than `T`: this host's own accept for a direct connection, and the introducer's
published `admittedAtMillis` for an indirect one. An entry nobody dated is undated, not
recent, and loses — silence must lose here, or every sync pass would quietly undo every
eviction.

An outranked record is kept rather than deleted — the publisher's document goes on
carrying it, so deleting it would only mean re-reading it on the next pass — but it stops
being *in force*, and `tolar-mcp connections` lists only the ones that are. An account
sitting in the roster must never also be printed as removed from it; that would be two
contradictory statements about one present, with no way to tell which to believe.

**Clock skew is real and is not corrected.** `atMillis` comes from the evicting device and
the admission time usually from another one. Whoever is ahead wins. There is no shared
clock and no authority to appeal to, so this is named rather than papered over.

**The agent relays no eviction it did not author about itself.** lc-gx2w has a member who
reads an eviction republish it, so the removal floods the household. This agent
deliberately does not do that half: a reader verifies the *document's* signature — ours —
and cannot check the `by` field inside it, so a relayed eviction and an authored one are
the same bytes to everyone downstream. Flooding would hand the agent the eviction power
back through the door it was just taken out of. It obeys locally and publishes only its
own departure.

#### What this is, and what it is not

This is **not enforcement**. `Connection.kind` is operator-asserted and, in the roster's
own words, "nothing verifies the claim and nothing enforces the label", so a peer-side
rule of the form "ignore evictions authored by kind=agent" is advisory and cannot survive
a modified agent. Removing the capability here is what makes the rule true for the
*shipping* agent, and it is worth more than the label check because it does not depend on
anyone else's opinion of what this uuid is. It still does not bind a hostile
reimplementation of the protocol. Option (a) in lc-gx2w, honestly labelled; option (b),
which needs signed admission records, is a client-side change and is not this.

#### The two fields this adds to the grant document

Both are optional in both directions, so a peer that has neither reads and writes exactly
as before:

```jsonc
{
  "connections": [
    { "uuid": "…", "signKey": "…", "encKey": "…", "scopes": ["CARDS"], "kind": "PERSON",
      // Only on the entries the publisher admitted itself. A relayed entry is undated,
      // because only the account that admitted somebody can date that admission.
      "admittedAtMillis": 1800000000000 }
  ],
  // Omitted entirely when there are none.
  "evictions": [ { "uuid": "…", "atMillis": 1800000000001, "by": "…" } ]
}
```

### Saying no (`lcm-co0`)

`decline <id>` is the other answer, and it has two halves that fail differently.

The dismissal is **local**: the backend has no delete route for a `requestShare`, so the
id joins `handledRequestIds` and the inbox stops offering it. That half cannot fail, and
it happens first.

Recording the refusal where the requester can read it is a `PUT
/api/shareResponse/{id}` — a tiny decision envelope sealed to them alone and signed over
the request id, the port of `sync/sharing/ShareResponse.kt`. Without it their app sits at
"waiting" forever for an invite that was in fact refused, because an accept is the only
answer a grant document can imply. It is **best-effort**: a decision that does not reach
the server leaves them seeing silence, which is a true statement about what they know, so
the CLI reports that outcome rather than a delivered "no". Silence is never a decline —
nothing here, and nothing in the app, ever collapses the two.

Declining an account this agent already shares with is refused: it would tell them "no"
while the grant document keeps saying yes. Stopping the sharing is a separate decision,
and — since this agent cannot remove anybody — it is either a member removing them in the
app or `tolar-mcp leave`.

## Beads

Work is tracked in the `loyaltyCardMcp` Gas Town rig (prefix `lcm-`). Design lives
in the Android repo at `docs/PRD-agent-connection.md` (§4, §6, §7).

- `lcm-au3` — peer core: identity, envelope crypto, REST client (from lc-f9o) ✅
- `lcm-ffs` — card read + agent-owned card write tools (from lc-6du) ✅
- `lcm-a5e` — shopping-list write tools with stamp discipline (from lc-bmb) ✅
- `lcm-bgp` — shared merge test vectors across app and MCP (from lc-0sg)
- `lcm-gll` — read card photo bytes (`ImageCipher` port) ✅
- `lcm-co0` — decline/dismiss an inbound share request ✅
- `lcm-8lm` — merge peers of peers from the verified grant doc (agent half of lc-uj5o) ✅
- `lcm-9m7` — the agent cannot evict; it obeys evictions and can leave (agent half of
  lc-gx2w) ✅
- `lcm-hfd` — household membership implies all scopes (agent half of lc-gx2w) ✅

## License

MIT — see [LICENSE](LICENSE).
