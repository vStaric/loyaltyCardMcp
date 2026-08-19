import { createHash } from 'node:crypto';
import type { SodiumCrypto } from '../crypto/sodium.js';

/** HTTP header names for the per-request Ed25519 signature scheme. */
export const SIG_HEADER_UUID = 'X-Tolar-Uuid';
export const SIG_HEADER_VER = 'X-Tolar-Ver';
export const SIG_HEADER_SIG = 'X-Tolar-Sig';

/**
 * Lowercase-hex SHA-256 of `data` (64 chars) — the body hash that closes the
 * canonical signing string. Matches the server's `Crypto.sha256Hex`.
 */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build the canonical message a per-request signature covers — the single source of
 * truth shared with the server's `auth/Signature.kt#canonicalMessage` and the Android
 * client's `canonicalMessage`. Pinned byte-for-byte by tests so the implementations
 * cannot drift; a mismatch silently breaks every signed write.
 *
 * ```
 * <METHOD>\n<path>\n<ver>\n<lowercase-hex SHA-256 of the raw body>
 * ```
 * `METHOD` is uppercased, `path` excludes the query string, `ver` is decimal, and the
 * body hash is over the exact bytes sent (so the signer must sign the same bytes the
 * HTTP layer writes — never reformat the body after signing).
 */
export function canonicalMessage(
  method: string,
  path: string,
  ver: number,
  body: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(ver)) {
    throw new RangeError(`request ver must be a safe integer, was ${ver}`);
  }
  return Buffer.from(
    `${method.toUpperCase()}\n${path}\n${ver.toString(10)}\n${sha256Hex(body)}`,
    'utf8',
  );
}

/**
 * Signs HTTP writes for the "no accounts" scheme: the peer's Ed25519 key
 * authenticates a single request via the signature headers. Used for user PUTs (TOFU
 * bootstrap / rotation) and the origin-signed listings — envelope-carrying writes
 * (cards, shopping-list, share) instead self-authenticate through their embedded
 * signature and need no signer.
 *
 * Bound to one identity for the process: `uuid` is the signer's account UUID and
 * `ed25519SecretKey` its 64-byte libsodium signing secret.
 */
export class RequestSigner {
  constructor(
    private readonly uuid: string,
    private readonly ed25519SecretKey: Uint8Array,
    private readonly sodium: SodiumCrypto,
  ) {}

  /**
   * The three signature headers authenticating a write of `body` to `path` at the
   * target `ver`. `path` must be exactly the request path (no query string) and
   * `body` exactly the bytes that will be sent.
   */
  headers(method: string, path: string, ver: number, body: Uint8Array): Record<string, string> {
    const sig = this.sodium.signDetached(
      canonicalMessage(method, path, ver, body),
      this.ed25519SecretKey,
    );
    return {
      [SIG_HEADER_UUID]: this.uuid,
      [SIG_HEADER_VER]: ver.toString(10),
      [SIG_HEADER_SIG]: Buffer.from(sig).toString('base64'),
    };
  }
}
