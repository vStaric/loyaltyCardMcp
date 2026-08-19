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

`ShoppingMerge` and `CardMerge` land with the tool beads, and `lcm-bgp` is where their
shared vectors go.

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
npx tolar-mcp status            # account uuid and config location
npx tolar-mcp export-phrase     # the recovery phrase — the complete backup
npx tolar-mcp import-phrase "…" # adopt an identity on another host
```

The MCP tool surface itself is not in this bead. `pair` is what has to exist first,
because an agent nobody has accepted has nothing to expose.

## Beads

Work is tracked in the `loyaltyCardMcp` Gas Town rig (prefix `lcm-`). Design lives
in the Android repo at `docs/PRD-agent-connection.md` (§4, §6, §7).

- peer core — identity, envelope crypto, REST client (from lc-f9o)
- card read + agent-owned card write tools (from lc-6du)
- shopping-list write tools with stamp discipline (from lc-bmb)
- shared merge test vectors across app and MCP (from lc-0sg)
