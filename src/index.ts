/**
 * The Tolar MCP server's **peer core** — identity, envelope crypto, and the REST
 * client (PRD-agent-connection §7.1, bead lcm-au3).
 *
 * This is a Tolar *client*, not a backend feature: it speaks the existing REST API
 * with the existing envelope crypto, so the server gains no endpoint and learns
 * nothing it does not already see.
 *
 * These modules are a **second implementation** of semantics the Android app already
 * ships. Where they encode a format both sides must agree on — the identity
 * derivation, the envelope signed bytes, the per-request canonical message, the share
 * code payload — the tests pin the exact vectors the app and backend pin, because a
 * drift here does not fail loudly: it mints a different account, or produces envelopes
 * the server answers with `bad_signature`.
 */

export * from './config.js';
export * from './peer.js';

export * from './crypto/bip39.js';
export * from './crypto/envelope.js';
export * from './crypto/envelopeCrypto.js';
export * from './crypto/identity.js';
export * from './crypto/identityDeriver.js';
export * from './crypto/identityStore.js';
export * from './crypto/sodium.js';

export * from './sharing/connectInvite.js';
export * from './sharing/keyFingerprint.js';
export * from './sharing/shareCode.js';

export * from './sync/apiError.js';
export * from './sync/httpTolarApi.js';
export * from './sync/json.js';
export * from './sync/requestSigner.js';
export * from './sync/syncState.js';
export * from './sync/tolarApi.js';
export * from './sync/wire.js';
