import type { Envelope } from '../crypto/envelope.js';
import {
  arr,
  asObject,
  boolOr,
  int,
  intOr,
  obj,
  optObj,
  optStr,
  parseJsonObject,
  str,
  stringMap,
} from './json.js';

/**
 * JSON wire DTOs for the zero-knowledge sync backend. These mirror the server's own
 * types (`loyaltyCardBe` route models) and the Android client's `sync/Wire.kt`, so
 * all three share one shape; field names are the JSON keys and MUST not drift.
 *
 * The crypto layer ({@link Envelope} and friends) is kept free of wire concerns. This
 * file is the only bridge between the in-memory envelope and its JSON, and it carries
 * the base64 fields **verbatim** — the server recomputes the envelope signature over
 * exactly these strings, so no re-encoding may happen in between.
 */

/**
 * Public account profile from `GET /api/user/{uuid}`. Everything is public by design:
 * `signKey` verifies the user's signatures, `encKey` lets others wrap content keys to
 * them, and `displayNameEnc` is opaque ciphertext (or absent).
 */
export interface UserProfileDto {
  readonly displayNameEnc: string | null;
  readonly signKey: string;
  readonly encKey: string;
  readonly ver: number;
}

/**
 * Body of `PUT /api/user/{uuid}`. The first write binds `signKey` via TOFU; later
 * writes declare the (possibly rotated) keys and are signed by the *existing* key.
 */
export interface UserPutBody {
  readonly signKey: string;
  readonly encKey: string;
  readonly displayNameEnc?: string | null;
}

/** One author's slice of a shared shopping list, from the open list GET. */
export interface SliceViewDto {
  readonly authorUuid: string;
  readonly ver: number;
  readonly envelope: Envelope;
}

/** All slices of a shared shopping list; the client merges them into one list. */
export interface ShoppingListViewDto {
  readonly listId: string;
  readonly slices: readonly SliceViewDto[];
}

/**
 * Body of the permissionless `POST /api/requestShare/{originUuid}`. The server
 * light-validates the three `requester*` fields then stores it verbatim for the
 * origin to act on; `displayName` is optional metadata.
 */
export interface ShareRequestBody {
  readonly requesterUuid: string;
  readonly requesterSignKey: string;
  readonly requesterEncKey: string;
  readonly displayName?: string | null;
  /**
   * `"agent"` when the requester says it is one (lc-wgx) — optional metadata in
   * exactly the sense `displayName` is, and believed exactly as much: it pre-fills the
   * accept screen's answer and decides nothing.
   *
   * A raw string rather than a union on purpose. This is an untrusted field on a
   * permissionless route, so a value neither end recognises must degrade to "no
   * claim" — parsed with {@link connectionKindFromWire}, which is total.
   */
  readonly kind?: string | null;
}

/**
 * One share request in an origin's inbox.
 *
 * `responded` is the *origin's own* bookkeeping — whether that account has already
 * recorded a decision — so a reinstalled client does not re-prompt. It says nothing
 * about *what* was decided: only the requester can decrypt that.
 */
export interface ShareRequestViewDto {
  readonly id: number;
  readonly requester: ShareRequestBody;
  readonly createdAt: string;
  readonly responded: boolean;
}

/** All pending share requests addressed to an origin, oldest first. */
export interface ShareRequestsViewDto {
  readonly originUuid: string;
  readonly requests: readonly ShareRequestViewDto[];
}

/**
 * The issue body of `POST /api/pairingCode`: the pairing payload a short code stands
 * in for — exactly the material the long share code spells out.
 *
 * The server stores this verbatim and holds no opinion about it beyond one check: a
 * payload's `uuid` must equal the *authenticated signer* of the issue request, so no
 * account can mint a code advertising somebody else's identity.
 */
export interface PairingPayloadDto {
  readonly uuid: string;
  readonly encKeyFingerprint: string;
  readonly displayName?: string | null;
  /** `"agent"` when the issuer says it is one — self-declared and only ever a pre-tick. */
  readonly kind?: string | null;
}

/**
 * `{ "code": "4F9K-2C7X", "expiresAt": "...", "maxUses": N }` — the minted code.
 *
 * This response is the **only** time the code exists outside the minting client: the
 * server keeps just its hash and cannot re-derive it, so there is no route that reads
 * one back. A client that loses it mints another.
 */
export interface PairingCodeIssuedDto {
  readonly code: string;
  readonly expiresAt: string | null;
  readonly maxUses: number;
}

/**
 * What the holder of a code gets back.
 *
 * `issuerUuid` is the account that *signed* the issue request — the server's own
 * statement about who minted this handle, rather than something read out of
 * `payload`. "Authority" only within this response, though: nothing in it is signed,
 * so agreement between the two is the server being self-consistent and not proof of
 * who minted anything.
 *
 * `payload` stays raw JSON on purpose: it is the *client's* format, so a payload this
 * version cannot read is a client-level "that isn't one of our invites" and not a
 * transport failure.
 */
export interface PairingCodeResolvedDto {
  readonly issuerUuid: string;
  readonly payload: Record<string, unknown>;
  readonly expiresAt: string | null;
  readonly usesRemaining: number;
}

/** `ShareResponseViewDto.status` when the origin has not answered — *not* a decline. */
export const SHARE_RESPONSE_PENDING = 'pending';

/** `ShareResponseViewDto.status` when a decision envelope is stored for the request. */
export const SHARE_RESPONSE_ANSWERED = 'answered';

/**
 * What the requester sees when they poll their own share request.
 *
 * *Ignored* is {@link SHARE_RESPONSE_PENDING}; *accepted* and *declined* are both
 * {@link SHARE_RESPONSE_ANSWERED} plus a `response` envelope only the requester can
 * decrypt. Silence is never reported as a decline — the server has no timeout and
 * never answers on an origin's behalf.
 */
export interface ShareResponseViewDto {
  readonly requestId: number;
  readonly status: string;
  readonly response: Envelope | null;
  readonly respondedAt: string | null;
}

// --- encoding -------------------------------------------------------------------

/**
 * Project the in-memory {@link Envelope} onto its wire JSON, verbatim. `keys` is
 * omitted when empty (the server treats an absent `keys` and an empty map
 * identically) and `signature` is omitted when the envelope is unsigned.
 */
export function envelopeToWire(envelope: Envelope): Record<string, unknown> {
  const out: Record<string, unknown> = {
    data: {
      iv: envelope.data.iv,
      ciphertext: envelope.data.ciphertext,
      tag: envelope.data.tag,
    },
  };
  if (Object.keys(envelope.keys).length > 0) out.keys = { ...envelope.keys };
  if (envelope.signature) {
    out.signature = {
      by: envelope.signature.by,
      ver: envelope.signature.ver,
      sig: envelope.signature.sig,
    };
  }
  return out;
}

export function userPutBodyToWire(body: UserPutBody): Record<string, unknown> {
  const out: Record<string, unknown> = { signKey: body.signKey, encKey: body.encKey };
  if (body.displayNameEnc != null) out.displayNameEnc = body.displayNameEnc;
  return out;
}

export function shareRequestBodyToWire(body: ShareRequestBody): Record<string, unknown> {
  const out: Record<string, unknown> = {
    requesterUuid: body.requesterUuid,
    requesterSignKey: body.requesterSignKey,
    requesterEncKey: body.requesterEncKey,
  };
  if (body.displayName != null) out.displayName = body.displayName;
  if (body.kind != null) out.kind = body.kind;
  return out;
}

export function pairingPayloadToWire(body: PairingPayloadDto): Record<string, unknown> {
  const out: Record<string, unknown> = {
    uuid: body.uuid,
    encKeyFingerprint: body.encKeyFingerprint,
  };
  if (body.displayName != null) out.displayName = body.displayName;
  if (body.kind != null) out.kind = body.kind;
  return out;
}

// --- decoding -------------------------------------------------------------------

/** Reconstruct the crypto {@link Envelope} from its wire JSON, verbatim. */
export function envelopeFromWire(o: Record<string, unknown>, what = 'envelope'): Envelope {
  const data = obj(o, 'data', what);
  const signature = optObj(o, 'signature', what);
  return {
    data: {
      iv: str(data, 'iv', `${what}.data`),
      ciphertext: str(data, 'ciphertext', `${what}.data`),
      tag: str(data, 'tag', `${what}.data`),
    },
    keys: stringMap(o, 'keys', what),
    signature: signature
      ? {
          by: str(signature, 'by', `${what}.signature`),
          ver: int(signature, 'ver', `${what}.signature`),
          sig: str(signature, 'sig', `${what}.signature`),
        }
      : undefined,
  };
}

export function decodeEnvelope(text: string): Envelope {
  return envelopeFromWire(parseJsonObject(text, 'envelope'));
}

/** `{ "ver": N }` — the version now stored, returned by every successful write. */
export function decodeWriteVer(text: string): number {
  return int(parseJsonObject(text, 'write response'), 'ver', 'write response');
}

/** `{ "error": "<code>" }` — the server's machine-readable error body, if it sent one. */
export function decodeErrorCode(text: string): string | null {
  try {
    return optStr(parseJsonObject(text, 'error'), 'error', 'error');
  } catch {
    return null;
  }
}

export function decodeUserProfile(text: string): UserProfileDto {
  const o = parseJsonObject(text, 'user');
  return {
    displayNameEnc: optStr(o, 'displayNameEnc', 'user'),
    signKey: str(o, 'signKey', 'user'),
    encKey: str(o, 'encKey', 'user'),
    ver: int(o, 'ver', 'user'),
  };
}

export function decodeShoppingListView(text: string): ShoppingListViewDto {
  const o = parseJsonObject(text, 'shoppinglist');
  return {
    listId: str(o, 'listId', 'shoppinglist'),
    slices: arr(o, 'slices', 'shoppinglist').map((raw, i) => {
      const slice = asObject(raw, `shoppinglist.slices[${i}]`);
      return {
        authorUuid: str(slice, 'authorUuid', `shoppinglist.slices[${i}]`),
        ver: int(slice, 'ver', `shoppinglist.slices[${i}]`),
        envelope: envelopeFromWire(
          obj(slice, 'envelope', `shoppinglist.slices[${i}]`),
          `shoppinglist.slices[${i}].envelope`,
        ),
      };
    }),
  };
}

/** `{ "id": N }` ack for an accepted share-request append. */
export function decodeShareRequestId(text: string): number {
  return int(parseJsonObject(text, 'requestShare'), 'id', 'requestShare');
}

export function decodeShareRequestsView(text: string): ShareRequestsViewDto {
  const o = parseJsonObject(text, 'requestShare');
  return {
    originUuid: str(o, 'originUuid', 'requestShare'),
    requests: arr(o, 'requests', 'requestShare').map((raw, i) => {
      const what = `requestShare.requests[${i}]`;
      const req = asObject(raw, what);
      const requester = obj(req, 'requester', what);
      return {
        id: int(req, 'id', what),
        createdAt: str(req, 'createdAt', what),
        responded: boolOr(req, 'responded', false, what),
        requester: {
          requesterUuid: str(requester, 'requesterUuid', `${what}.requester`),
          requesterSignKey: str(requester, 'requesterSignKey', `${what}.requester`),
          requesterEncKey: str(requester, 'requesterEncKey', `${what}.requester`),
          displayName: optStr(requester, 'displayName', `${what}.requester`),
          kind: optStr(requester, 'kind', `${what}.requester`),
        },
      };
    }),
  };
}

export function decodePairingCodeIssued(text: string): PairingCodeIssuedDto {
  const o = parseJsonObject(text, 'pairingCode');
  return {
    code: str(o, 'code', 'pairingCode'),
    expiresAt: optStr(o, 'expiresAt', 'pairingCode'),
    maxUses: intOr(o, 'maxUses', 1, 'pairingCode'),
  };
}

export function decodePairingCodeResolved(text: string): PairingCodeResolvedDto {
  const o = parseJsonObject(text, 'pairingResolve');
  return {
    issuerUuid: str(o, 'issuerUuid', 'pairingResolve'),
    payload: obj(o, 'payload', 'pairingResolve'),
    expiresAt: optStr(o, 'expiresAt', 'pairingResolve'),
    usesRemaining: intOr(o, 'usesRemaining', 0, 'pairingResolve'),
  };
}

export function decodeShareResponseView(text: string): ShareResponseViewDto {
  const o = parseJsonObject(text, 'shareResponse');
  const response = optObj(o, 'response', 'shareResponse');
  return {
    requestId: int(o, 'requestId', 'shareResponse'),
    status: str(o, 'status', 'shareResponse'),
    response: response ? envelopeFromWire(response, 'shareResponse.response') : null,
    respondedAt: optStr(o, 'respondedAt', 'shareResponse'),
  };
}
