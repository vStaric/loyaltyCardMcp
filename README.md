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

## Beads

Work is tracked in the `loyaltyCardMcp` Gas Town rig (prefix `lcm-`). Design lives
in the Android repo at `docs/PRD-agent-connection.md` (§4, §6, §7).

- peer core — identity, envelope crypto, REST client (from lc-f9o)
- card read + agent-owned card write tools (from lc-6du)
- shopping-list write tools with stamp discipline (from lc-bmb)
- shared merge test vectors across app and MCP (from lc-0sg)
