/**
 * The Tolar MCP server: an AI agent as an ordinary Tolar peer, with the card tool
 * surface built on the peer core (PRD-agent-connection §7.1, §7.3).
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

export * from './agent.js';
export * from './config.js';
export * from './peer.js';

export * from './cards/card.js';
export * from './cards/cardService.js';

export * from './merge/cardMerge.js';

export * from './mcp/cardTools.js';
export * from './mcp/server.js';
export * from './mcp/tool.js';

export * from './crypto/bip39.js';
export * from './crypto/envelope.js';
export * from './crypto/envelopeCrypto.js';
export * from './crypto/identity.js';
export * from './crypto/identityDeriver.js';
export * from './crypto/identityStore.js';
export * from './crypto/sodium.js';

export * from './sharing/connectInvite.js';
export * from './sharing/connections.js';
export * from './sharing/keyFingerprint.js';
export * from './sharing/roster.js';
export * from './sharing/rosterStore.js';
export * from './sharing/shareCode.js';

export * from './sync/apiError.js';
export * from './sync/blobPointer.js';
export * from './sync/cardSnapshot.js';
export * from './sync/httpTolarApi.js';
export * from './sync/json.js';
export * from './sync/publishResource.js';
export * from './sync/requestSigner.js';
export * from './sync/syncState.js';
export * from './sync/tolarApi.js';
export * from './sync/wire.js';
