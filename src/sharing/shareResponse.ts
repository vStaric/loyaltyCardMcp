import type { Envelope } from '../crypto/envelope.js';
import type { EnvelopeCrypto, Recipient } from '../crypto/envelopeCrypto.js';
import type { Identity } from '../crypto/identity.js';

/**
 * The decision an origin records against an inbound share request — the port of
 * `sync/sharing/ShareResponse.kt` (lcb-t4j).
 *
 * ## Why a decline needs a document at all
 * An **accept** needs none: the requester learns it by finding its own uuid in the
 * grant document's recipient key map. A **decline** has no such shadow — nothing is
 * published, nothing changes — so without this envelope the requester's app sits at
 * "no answer yet" forever for an invite that was in fact refused.
 *
 * The reverse direction (`ShareResponseCodec.open`) is deliberately not ported: this
 * agent never sends a `requestShare`, so it is never the party who reads one back. The
 * app owns that half, and it verifies against the key it pinned when it sent the
 * request — a decline is a claim about somebody else, so it is only ever believed from
 * a signature.
 */

/** Envelope `resourceType` for a decision — must match the server's `SHARE_RESPONSE_TYPE`. */
export const SHARE_RESPONSE_TYPE = 'shareresponse';

/**
 * The sealed plaintext, in the shape `ShareResponsePayload` deserializes.
 *
 * One boolean and the id it answers. There is no third value: an unanswered request
 * has **no response row at all**, and that absence is what keeps "ignored"
 * distinguishable from "declined". The id rides inside as well as in the signature so
 * the reader can cross-check the two.
 */
export function encodeShareResponse(requestId: number, accepted: boolean): string {
  return JSON.stringify({ requestId, accepted });
}

/**
 * Seal `accepted` as the answer to `requestId`: readable only by `requester`, signed
 * by `identity` — which must be the request's origin, or the server refuses the write.
 *
 * `ver` is 0 because a decision is written once and never revised; the server's
 * decision table is append-only and keeps the first answer it stored.
 */
export function sealShareResponse(
  crypto: EnvelopeCrypto,
  identity: Identity,
  requestId: number,
  accepted: boolean,
  requester: Recipient,
): Envelope {
  return crypto.seal(
    SHARE_RESPONSE_TYPE,
    String(requestId),
    0,
    Buffer.from(encodeShareResponse(requestId, accepted), 'utf8'),
    [requester],
    identity.uuid,
    identity.signingKeyPair.secretKey,
  );
}
