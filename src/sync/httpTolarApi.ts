import type { Envelope } from '../crypto/envelope.js';
import {
  BadSignatureError,
  HttpError,
  KeyMismatchError,
  NetworkError,
  PayloadTooLargeError,
  RateLimitedError,
  StaleVersionError,
  ApiError,
} from './apiError.js';
import type { RequestSigner } from './requestSigner.js';
import type { TolarApi } from './tolarApi.js';
import {
  decodeEnvelope,
  decodeErrorCode,
  decodePairingCodeIssued,
  decodePairingCodeResolved,
  decodeShareRequestId,
  decodeShareRequestsView,
  decodeShareResponseView,
  decodeShoppingListView,
  decodeUserProfile,
  decodeWriteVer,
  envelopeToWire,
  pairingPayloadToWire,
  shareRequestBodyToWire,
  userPutBodyToWire,
  type PairingCodeIssuedDto,
  type PairingCodeResolvedDto,
  type PairingPayloadDto,
  type ShareRequestBody,
  type ShareRequestsViewDto,
  type ShareResponseViewDto,
  type ShoppingListViewDto,
  type UserProfileDto,
  type UserPutBody,
} from './wire.js';

const JSON_MEDIA = 'application/json; charset=utf-8';
const OCTET_MEDIA = 'application/octet-stream';
const EMPTY_BODY = new Uint8Array(0);

/** Timeouts tuned for a background sync — the port of the app's OkHttp client config. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpTolarApiOptions {
  /** Overall per-call deadline, after which the request is aborted. */
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * `fetch`-based implementation of {@link TolarApi} — the port of `sync/HttpTolarApi.kt`.
 *
 * Maps the backend's REST surface to typed calls, signs the per-request authenticated
 * endpoints with `signer`, and translates the server's HTTP/error contract into
 * {@link ApiError}s.
 *
 * The base URL is trimmed of a trailing slash so paths concatenate cleanly; the path
 * we build is also exactly what we sign, matching the server's `request.path()`.
 */
export class HttpTolarApi implements TolarApi {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    private readonly signer: RequestSigner,
    options: HttpTolarApiOptions = {},
  ) {
    this.base = new URL(baseUrl.replace(/\/+$/, ''));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  // --- user ---------------------------------------------------------------------

  async getUser(uuid: string): Promise<UserProfileDto | null> {
    return this.getOrNull(`/api/user/${enc(uuid)}`, decodeUserProfile);
  }

  async putUser(uuid: string, body: UserPutBody, ver: number): Promise<number> {
    const path = `/api/user/${enc(uuid)}`;
    // Serialize once and sign the exact bytes we send — the server hashes the received
    // body, so it must not be reformatted between signing and sending.
    const bytes = utf8(JSON.stringify(userPutBodyToWire(body)));
    return decode(
      decodeWriteVer,
      await this.send(path, {
        method: 'PUT',
        body: bytes,
        contentType: JSON_MEDIA,
        sign: { ver },
      }),
    );
  }

  async deleteUser(uuid: string): Promise<void> {
    const path = `/api/user/${enc(uuid)}`;
    // Signed DELETE with no body: the canonical message hashes an empty body, like the
    // signed GETs. Signed at ver 0 — an erase targets no version, it takes the account
    // whatever version it is on.
    //
    // Already gone is the outcome we asked for, not a failure to report.
    await this.send(path, {
      method: 'DELETE',
      sign: { ver: 0 },
      notFoundIsOk: true,
    });
  }

  // --- cards --------------------------------------------------------------------

  async getCards(uuid: string): Promise<Envelope | null> {
    return this.getOrNull(`/api/cards/${enc(uuid)}`, decodeEnvelope);
  }

  async putCards(uuid: string, envelope: Envelope): Promise<number> {
    return this.putEnvelope(`/api/cards/${enc(uuid)}`, envelope);
  }

  // --- shopping list ------------------------------------------------------------

  async getShoppingList(listId: string): Promise<ShoppingListViewDto> {
    return decode(decodeShoppingListView, await this.send(`/api/shoppinglist/${enc(listId)}`, {}));
  }

  async putShoppingSlice(listId: string, authorUuid: string, envelope: Envelope): Promise<number> {
    // `listId::authorUuid` is one path segment, colons and all — the resource id the
    // envelope signature is bound to, so it must survive encoding unsplit.
    return this.putEnvelope(`/api/shoppinglist/${enc(`${listId}::${authorUuid}`)}`, envelope);
  }

  // --- image blobs --------------------------------------------------------------

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    // Binary body, not an envelope, so this is per-request signed like the other
    // non-envelope writes: the signature covers a hash of the exact bytes sent, which
    // is the same thing the address is. The blob store has no versions — the address
    // *is* the identity — so the required `ver` is signed as 0.
    //
    // 201 on the first upload, 200 when the blob is already stored; both mean the bytes
    // are there, which is all the caller needs to know.
    await this.send(`/api/blob/${enc(hash)}`, {
      method: 'PUT',
      body: bytes,
      contentType: OCTET_MEDIA,
      sign: { ver: 0 },
    });
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.call(`/api/blob/${enc(hash)}`, {}, async (response) => {
      if (response.status === 404) return null;
      // Ciphertext, so unlike every other response here it must be read as bytes;
      // decoding it as text would corrupt it. Only an error body is read as text.
      if (!response.ok) throw mapError(response.status, await response.text());
      return new Uint8Array(await response.arrayBuffer());
    });
  }

  // --- sharing ------------------------------------------------------------------

  async postRequestShare(originUuid: string, body: ShareRequestBody): Promise<number> {
    return decode(
      decodeShareRequestId,
      await this.send(`/api/requestShare/${enc(originUuid)}`, {
        method: 'POST',
        body: utf8(JSON.stringify(shareRequestBodyToWire(body))),
        contentType: JSON_MEDIA,
      }),
    );
  }

  async getRequestShare(originUuid: string): Promise<ShareRequestsViewDto> {
    // Signed GET: the canonical message hashes an empty body.
    return decode(
      decodeShareRequestsView,
      await this.send(`/api/requestShare/${enc(originUuid)}`, { sign: { ver: 0 } }),
    );
  }

  async putShareResponse(requestId: number, envelope: Envelope): Promise<number> {
    return this.putEnvelope(`/api/shareResponse/${requestId}`, envelope);
  }

  async getShareResponse(requestId: number): Promise<ShareResponseViewDto | null> {
    // Signed GET, like the inbox listing: the canonical message hashes an empty body.
    const text = await this.send(`/api/shareResponse/${requestId}`, {
      sign: { ver: 0 },
      notFoundIsNull: true,
    });
    return text === null ? null : decode(decodeShareResponseView, text);
  }

  // --- short pairing code -------------------------------------------------------

  async postPairingCode(body: PairingPayloadDto): Promise<PairingCodeIssuedDto> {
    // Minting a code mints a capability, so the server charges it to an account with a
    // bound key. Signed like the other body-carrying signed writes: the exact bytes we
    // send, at ver 0 (a pairing code has no version).
    return decode(
      decodePairingCodeIssued,
      await this.send('/api/pairingCode', {
        method: 'POST',
        body: utf8(JSON.stringify(pairingPayloadToWire(body))),
        contentType: JSON_MEDIA,
        sign: { ver: 0 },
      }),
    );
  }

  async postPairingResolve(code: string): Promise<PairingCodeResolvedDto | null> {
    // A POST, not a GET, and deliberately so: the code is a short-lived secret and a
    // GET would leave it in URLs, proxy logs and browser history. Unsigned — the whole
    // point is that a stranger holding the code can complete the pairing.
    //
    // Unknown, expired and spent are one 404 by design; see TolarApi.
    const text = await this.send('/api/pairingCode/resolve', {
      method: 'POST',
      body: utf8(JSON.stringify({ code })),
      contentType: JSON_MEDIA,
      notFoundIsNull: true,
    });
    return text === null ? null : decode(decodePairingCodeResolved, text);
  }

  // --- share / roster -----------------------------------------------------------

  async getShare(uuid: string): Promise<Envelope | null> {
    return this.getOrNull(`/api/share/${enc(uuid)}`, decodeEnvelope);
  }

  async putShare(uuid: string, envelope: Envelope): Promise<number> {
    return this.putEnvelope(`/api/share/${enc(uuid)}`, envelope);
  }

  // --- plumbing -----------------------------------------------------------------

  /** PUT a signed `envelope` — these self-authenticate, so no signature headers. */
  private async putEnvelope(path: string, envelope: Envelope): Promise<number> {
    return decode(
      decodeWriteVer,
      await this.send(path, {
        method: 'PUT',
        body: utf8(JSON.stringify(envelopeToWire(envelope))),
        contentType: JSON_MEDIA,
      }),
    );
  }

  /** GET `path`; map a 404 to `null`, any other non-2xx to an {@link ApiError}. */
  private async getOrNull<T>(path: string, parse: (body: string) => T): Promise<T | null> {
    const text = await this.send(path, { notFoundIsNull: true });
    return text === null ? null : decode(parse, text);
  }

  private async send(
    path: string,
    req: RequestSpec & { notFoundIsNull: true },
  ): Promise<string | null>;
  private async send(path: string, req: RequestSpec): Promise<string>;
  private async send(path: string, req: RequestSpec): Promise<string | null> {
    return this.call(path, req, async (response) => {
      if (response.status === 404 && (req.notFoundIsNull || req.notFoundIsOk)) {
        return req.notFoundIsOk ? '' : null;
      }
      const text = await response.text();
      if (!response.ok) throw mapError(response.status, text);
      return text;
    });
  }

  /**
   * Run one request and hand the raw `Response` to `handle`. Transport failures,
   * timeouts and malformed JSON surface as {@link NetworkError}; an {@link ApiError}
   * thrown by `handle` passes through unchanged.
   */
  private async call<T>(
    path: string,
    req: RequestSpec,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    const method = req.method ?? 'GET';
    const body = req.body ?? EMPTY_BODY;
    const headers: Record<string, string> = {};
    if (req.contentType) headers['Content-Type'] = req.contentType;
    if (req.sign) Object.assign(headers, this.signer.headers(method, path, req.sign.ver, body));

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(new URL(path, this.base), {
        method,
        headers,
        // A GET/DELETE must carry no body at all — fetch rejects one — and the
        // signature already hashes the empty body the server will see.
        body: req.body ? bodyInit(req.body) : null,
        signal,
      });
    } catch (e) {
      throw new NetworkError(`transport failure: ${errorMessage(e)}`, { cause: e });
    }
    try {
      return await handle(response);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new NetworkError(`malformed response: ${errorMessage(e)}`, { cause: e });
    }
  }
}

interface RequestSpec {
  readonly method?: string;
  readonly body?: Uint8Array;
  readonly contentType?: string;
  /** Attach the per-request signature headers, signing at this `ver`. */
  readonly sign?: { readonly ver: number };
  /** A 404 resolves to `null` rather than throwing. */
  readonly notFoundIsNull?: boolean;
  /** A 404 is success with nothing to read (idempotent deletes). */
  readonly notFoundIsOk?: boolean;
}

/** Translate a non-2xx (status, body) into the matching {@link ApiError}. */
function mapError(status: number, body: string): ApiError {
  const code = decodeErrorCode(body);
  switch (status) {
    case 401:
      return new BadSignatureError(code ?? 'bad_signature');
    case 403:
      return new KeyMismatchError(code ?? 'key_mismatch');
    case 409:
      return new StaleVersionError(code ?? 'stale_version');
    case 413:
      return new PayloadTooLargeError(code ?? 'payload_too_large');
    case 429:
      return new RateLimitedError(code ?? 'rate_limited');
    default:
      return new HttpError(status, code);
  }
}

/**
 * Decode a 2xx body, translating a shape mismatch into the transport-level failure it
 * is. Callers are promised an {@link ApiError} and nothing else; a `DecodeError`
 * escaping raw would slip past every `catch (e) { if (e instanceof ApiError) ... }` a
 * caller writes and surface as an unhandled rejection instead of a retryable failure.
 */
function decode<T>(parse: (body: string) => T, body: string): T {
  try {
    return parse(body);
  } catch (e) {
    throw new NetworkError(`malformed response: ${errorMessage(e)}`, { cause: e });
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

/** A fresh copy, so a caller mutating its buffer cannot change what fetch sends. */
function bodyInit(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Percent-encode one path segment. The Android client relies on OkHttp doing this;
 * here it is explicit, because a uuid or blob hash that arrived from the wire must not
 * be able to inject a `/` or `?` and retarget the request — while the *signed* path
 * stays exactly the string we build, so signer and server agree.
 *
 * `:` is left alone. It is a legal path character (RFC 3986 `pchar`) and it is the
 * separator in a shopping-list slice id, `listId::authorUuid` — escaping it would
 * emit a path the Android client never emits, for no gain.
 */
function enc(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/g, ':');
}
