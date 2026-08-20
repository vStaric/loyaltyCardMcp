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

Four formats have to agree byte-for-byte with the app and the backend, and none of them
fails loudly when they stop agreeing — a drift mints a *different account*, or produces
envelopes the server answers with `bad_signature`. Each is pinned by known answers
rather than by round-trip tests, which cannot see this class of break at all:

- **identity derivation** — vectors computed on the JVM, through the same
  `javax.crypto` HMAC-SHA512 the app runs on (`test/identityDeriver.test.ts`)
- **envelope signed bytes** — the exact vectors the backend's `EnvelopeSignatureTest`
  and the app's `EnvelopeSigningTest` pin (`test/envelopeSigning.test.ts`)
- **per-request canonical message** — likewise, from `CanonicalMessageTest`
  (`test/canonicalMessage.test.ts`)
- **share code payload** — a code emitted by the app's `ShareCode.encode`,
  transliterated onto the JVM (`test/sharing.test.ts`)

`CardMerge` landed with the card tools (`lcm-ffs`) and `ShoppingMerge` lands with the
list ones; `lcm-bgp` is where their shared vectors go. The card snapshot encoder writes
its fields in the app's declaration order and omits defaults the way `kotlinx` does, so
the two implementations' bytes can be compared rather than merely re-parsed.

### Where the agent's keys live, and what protects them

The agent generates its own BIP-39 seed and derives its own uuid and keypairs from it.
It is never handed the user's (design §3.2). The phrase is stored in the config
directory — `TOLAR_MCP_HOME`, else `$XDG_CONFIG_HOME/tolar-mcp` — as `identity.json`,
mode `0600` in a `0700` directory.

**That is the whole protection.** The app seals its entropy with a hardware-backed
Android Keystore key; there is no equivalent on a laptop or a hosted box, so anyone who
can read that file is this agent. It is a real reduction relative to the phone, and it
is why the agent holds its own identity rather than the user's: the blast radius is
what the user shared with this agent, and one revoke in the app ends it.

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
npx tolar-mcp accept 7          # accept a request, after comparing its safety number
npx tolar-mcp revoke <uuid>     # stop sharing, and rotate the content key away
npx tolar-mcp serve             # the MCP server, on stdio — what a host launches
npx tolar-mcp status            # account uuid and config location
npx tolar-mcp export-phrase     # the recovery phrase — the complete backup
npx tolar-mcp import-phrase "…" # adopt an identity on another host
```

## The card tools (`lcm-ffs`)

`serve` exposes five tools: `list_cards`, `get_card`, `add_card`, `update_card`,
`delete_card`. Three properties are the deliverable, and each has tests naming it.

**The ownership refusal is explicit.** `cards/{uuid}` is a single blob signed by one
author, so an agent editing the user's card is not withheld — it is impossible, the
server would reject the signature. `update_card` and `delete_card` on somebody else's
card fail with *"cards belong to the account that created them"*, naming the owner, and
every card in a result carries `editableByThisAgent` so a caller never has to infer it.
An agent that reported an edit which did not happen would be worse than one that refuses.

**An ungranted resource is a refusal, not an empty list.** A connection that granted the
shopping list but not the cards (`lc-chp`) publishes a cards envelope with no content key
wrapped to this agent. That surfaces as a named `not_granted` entry with the sentence to
say — never as "you have no cards", which would be a lie about the user's data. The other
reasons (`not_published`, `not_verified`, `undecryptable`, `malformed`, `unreachable`)
stay distinguishable for the same reason.

**Writes never rest on a degraded read.** The cards blob is published whole, so the write
path re-reads it first — and a read this peer cannot verify or open throws rather than
yielding an empty list, because "no cards" followed by a publish is how you erase them all.

Photos travel as content-addressed blobs. This peer carries their pointers through a
re-publish untouched (losing them would erase the author's photos) and reports that a
photo *exists*; reading the bytes needs the app's `ImageCipher` format and is `lcm-gll`.

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

## Beads

Work is tracked in the `loyaltyCardMcp` Gas Town rig (prefix `lcm-`). Design lives
in the Android repo at `docs/PRD-agent-connection.md` (§4, §6, §7).

- `lcm-au3` — peer core: identity, envelope crypto, REST client (from lc-f9o) ✅
- `lcm-ffs` — card read + agent-owned card write tools (from lc-6du) ✅
- `lcm-a5e` — shopping-list write tools with stamp discipline (from lc-bmb)
- `lcm-bgp` — shared merge test vectors across app and MCP (from lc-0sg)
- `lcm-gll` — read card photo bytes, which needs the `ImageCipher` port
- `lcm-co0` — decline/dismiss an inbound share request
