# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/vStaric/loyaltyCardMcp/security/advisories/new).
That opens a private advisory only you and the maintainer can see, and it is the
only channel monitored for this.

This is a single-maintainer project. Expect an acknowledgement within about a week,
and please allow 90 days before public disclosure. There is no bounty.

If it helps, include the version or commit, what you did, what you expected, and
what happened instead. **Never paste a real recovery phrase, `identity.json`, or a
live envelope into a report** — a reduced test vector is worth more than a real one.

## What this project is

This is a Tolar **client**: an MCP server that holds its own account and talks to the
Tolar REST API with the existing envelope crypto. It is not the backend and not the
mobile app.

**In scope** — anything in this repository, particularly:

- BIP-39 codec and seed → identity derivation (`src/crypto/`)
- envelope seal / open / sign / verify, and the per-request signer
- the identity store: file permissions, write atomicity, what it leaks on error
- share codes, connect invites, key fingerprints, and the safety-number comparison
- the image cipher and blob handling
- shopping-list and card merge, where a defect lets one peer corrupt or forge
  another peer's rows
- dependency vulnerabilities that are actually reachable from this code

**Out of scope** — please report these elsewhere, or not at all:

- the Tolar backend and the Android / iOS apps; they are separate projects
- **the at-rest protection of `identity.json`.** It is mode `0600` in a `0700`
  directory, and that is the whole protection — deliberately, and documented in the
  README. There is no laptop equivalent of the app's hardware-backed Keystore. Anyone
  who can already read that file is this agent. That is a known and accepted
  limitation, not a vulnerability; it is why the agent holds *its own* identity rather
  than the user's, so the blast radius is only what was shared with it and one revoke
  in the app ends it.
- attacks that presuppose an already-compromised host, root, or the user's own shell
- the server learning envelope metadata it already sees by design (who published,
  when, how large) — the design assumes an honest-but-curious server that cannot read
  contents
- missing rate limits or hardening on a backend you stood up yourself

A finding that breaks the **agreement between implementations** is in scope and is
genuinely useful: if a vector in `test-vectors/` is wrong, or this server and the app
derive different accounts, sign different bytes, or merge to different states from the
same input, that is a real defect even when nothing is obviously "exploitable."

## Supported versions

Only the current `main` is supported. There are no tagged releases or backports yet.
