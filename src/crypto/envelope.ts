/**
 * The encrypted AEAD body of an {@link Envelope}. All three fields are standard
 * padded base64 (RFC 4648 §4) — the exact strings that travel on the wire and that
 * the signature is computed over verbatim.
 */
export interface EnvelopeData {
  /** AEAD nonce (24-byte XChaCha20 nonce), base64. */
  readonly iv: string;
  /** AEAD ciphertext without the tag, base64. */
  readonly ciphertext: string;
  /** 16-byte Poly1305 authentication tag, base64. */
  readonly tag: string;
}

/**
 * The envelope-carried Ed25519 signature block (`signature` in the wire JSON).
 * Authenticates the envelope's content independent of the transport — see
 * `loyaltyCardBe/docs/signing.md` §2.
 */
export interface EnvelopeSignatureBlock {
  /** Author UUID whose signing key produced `sig`. */
  readonly by: string;
  /** The signed monotonic version; bound into the signature and fed to the server CAS. */
  readonly ver: number;
  /** base64 of the 64-byte detached Ed25519 signature over the signed bytes. */
  readonly sig: string;
}

/**
 * A zero-knowledge resource envelope (PRD-sync-sharing §5): an AEAD-encrypted
 * payload, a per-recipient wrapped content key map, and an author signature.
 *
 * The server stores and returns this verbatim; only keyed recipients can decrypt,
 * and any reader can verify `signature` against the author's published key.
 */
export interface Envelope {
  readonly data: EnvelopeData;
  /** `recipient_uuid -> base64(wrapped CEK)`. Empty when the resource has no recipients yet. */
  readonly keys: Readonly<Record<string, string>>;
  /** Present once the envelope has been signed; absent for an as-yet-unsigned body. */
  readonly signature?: EnvelopeSignatureBlock | undefined;
}

/** Domain-separation prefix; must equal the server's `EnvelopeSignature.DOMAIN`. */
export const ENVELOPE_SIGNING_DOMAIN = 'tolar-env-v1';

/**
 * Recomputes the exact bytes an envelope author signs — the single source of truth
 * shared with the server's `auth/EnvelopeSignature.kt` and with the Android client's
 * `EnvelopeSigning`. Pinned byte-for-byte by tests against the backend's own vectors
 * so the three implementations cannot drift.
 *
 * The layout (UTF-8, `\n` = `0x0A`) is documented in `loyaltyCardBe/docs/signing.md`:
 * ```
 * "tolar-env-v1\n"
 *   + resourceType + "\n"      ("cards" | "shoppinglist" | "share")
 *   + resourceId   + "\n"      (the uuid; for list slices: listId + "::" + authorUuid)
 *   + decimal(ver) + "\n"
 *   + iv           + "\n"      (the base64 strings, verbatim)
 *   + ciphertext   + "\n"
 *   + tag          + "\n"
 *   + for each recipient sorted by uuid ASC: recipient_uuid + "=" + wrapped_cek + "\n"
 * ```
 * The base64 fields are concatenated exactly as they appear in the envelope, so there
 * is no JSON canonicalisation for the sides to disagree on.
 */
export function envelopeSignedBytes(
  resourceType: string,
  resourceId: string,
  ver: number,
  data: EnvelopeData,
  keys: Readonly<Record<string, string>>,
): Uint8Array {
  let s = '';
  s += `${ENVELOPE_SIGNING_DOMAIN}\n`;
  s += `${resourceType}\n`;
  s += `${resourceId}\n`;
  s += `${formatVer(ver)}\n`;
  s += `${data.iv}\n`;
  s += `${data.ciphertext}\n`;
  s += `${data.tag}\n`;
  // Sort by recipient UUID ascending (lexicographic over the canonical lowercase UUID
  // string), matching the server. `Array.prototype.sort` without a comparator sorts by
  // UTF-16 code unit, which agrees with the JVM's `String.compareTo` for these.
  for (const recipient of Object.keys(keys).sort()) {
    s += `${recipient}=${keys[recipient]}\n`;
  }
  return Buffer.from(s, 'utf8');
}

/**
 * Render a version the way the JVM's `Long.toString` does, which is what both the
 * server and the Android client concatenate into the signed bytes. Guards against a
 * non-integral `ver` reaching the wire as `7.5` or `1e+21` and producing a signature
 * the server recomputes differently.
 */
function formatVer(ver: number): string {
  if (!Number.isSafeInteger(ver)) {
    throw new RangeError(`envelope ver must be a safe integer, was ${ver}`);
  }
  return ver.toString(10);
}
