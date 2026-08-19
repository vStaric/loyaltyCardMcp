/**
 * A sync API call failed. The subtypes mirror the backend's error contract so
 * callers can branch on the *meaning* of a failure (notably reconcile on
 * {@link StaleVersionError}) rather than parsing HTTP codes at every call site.
 * Port of `sync/ApiException.kt`.
 */
export abstract class ApiError extends Error {
  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The write's `ver` was not strictly greater than the server's stored version
 * (HTTP 409, `stale_version`). The caller must GET the current state, reconcile, and
 * retry at a higher version.
 */
export class StaleVersionError extends ApiError {
  constructor(message = 'version is not strictly increasing') {
    super(message);
  }
}

/** Signature missing/malformed or did not verify (HTTP 401). */
export class BadSignatureError extends ApiError {
  constructor(message = 'signature rejected') {
    super(message);
  }
}

/** Signer is not the owner of the targeted resource (HTTP 403, `key_mismatch`). */
export class KeyMismatchError extends ApiError {
  constructor(message = 'signer does not own this resource') {
    super(message);
  }
}

/** Permissionless endpoint throttled (HTTP 429, `rate_limited`). */
export class RateLimitedError extends ApiError {
  constructor(message = 'rate limited') {
    super(message);
  }
}

/** Request body exceeded the server's cap (HTTP 413, `payload_too_large`). */
export class PayloadTooLargeError extends ApiError {
  constructor(message = 'payload too large') {
    super(message);
  }
}

/** Any other non-2xx response, carrying the HTTP status and server error code. */
export class HttpError extends ApiError {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}

/** Transport-level failure (connect/read timeout, DNS, TLS, malformed JSON). */
export class NetworkError extends ApiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
