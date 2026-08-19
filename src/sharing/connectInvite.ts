/**
 * What a peer says it is. Port of `ConnectionKind` from `sync/sharing/Roster.kt`.
 *
 * **A claim and nothing more.** It is self-declared: a peer could say it is a person.
 * It is a *labelling* control — the user is the one setting up the agent, so they know
 * — and the app's roster records what the user confirmed on the accept screen, not
 * what this field asserted (PRD-agent-connection §7.2, §7.4).
 */
export const CONNECTION_KIND_PERSON = 'person';
export const CONNECTION_KIND_AGENT = 'agent';

export type ConnectionKind = typeof CONNECTION_KIND_PERSON | typeof CONNECTION_KIND_AGENT;

/**
 * The kind `wire` names, or `person` for anything else — absent, empty, misspelt, or a
 * value some future version invented.
 *
 * Deliberately total. This parses a *claim* off a link or an inbox row, and a claim we
 * cannot read is not a reason to reject the invite: it just means the accept screen
 * opens with the box unticked and the user says what this peer is, which is where the
 * answer was always going to come from.
 */
export function connectionKindFromWire(wire: string | null | undefined): ConnectionKind {
  return wire?.toLowerCase() === CONNECTION_KIND_AGENT
    ? CONNECTION_KIND_AGENT
    : CONNECTION_KIND_PERSON;
}

export const INVITE_SCHEME = 'loyaltycard';
export const INVITE_HOST = 'share';

const PARAM_UUID = 'u';
const PARAM_FINGERPRINT = 'k';
const PARAM_NAME = 'n';
const PARAM_KIND = 't';

/**
 * A connect invitation — the payload of the `loyaltycard://share` deep link / QR this
 * agent hands to the user to start the sharing connection (PRD-sync-sharing §7, §8).
 * Port of `sync/sharing/ConnectInvite.kt`.
 *
 * It carries three things, all out-of-band relative to the server so the recipient
 * trusts the *link*, not the backend:
 * - `uuid` — the account to connect to (`user/{uuid}` locator);
 * - `encKeyFingerprint` — `base64url(SHA-256(encKey))` of our X25519 public key, the
 *   TOFU pin checked against the fetched `user` row;
 * - `displayName` — our chosen name, conveyed in the link itself (the server keeps no
 *   cleartext name) so the recipient can see *who* they are connecting to.
 *
 * The display name is base64url-encoded in the URL so names with spaces, `&`, or
 * non-ASCII survive transport without escaping ambiguity.
 *
 * A fourth, optional part rides along: `kind`, our own claim about whether we are a
 * person or an AI agent. It pre-fills the accept screen's answer rather than deciding
 * it; an invite that omits it or garbles it simply opens as a person.
 */
export interface ConnectInvite {
  readonly uuid: string;
  readonly encKeyFingerprint: string;
  readonly displayName: string | null;
  /**
   * What we say we are (`t=agent`). Self-declared, never verified; the app's roster
   * stores what the *user* confirmed, not this.
   */
  readonly kind: ConnectionKind;
}

/** Render the canonical `loyaltycard://share?u=…&k=…&n=…` link for `invite`. */
export function inviteToUri(invite: ConnectInvite): string {
  const params = [
    `${PARAM_UUID}=${invite.uuid}`,
    `${PARAM_FINGERPRINT}=${invite.encKeyFingerprint}`,
  ];
  const name = invite.displayName?.trim();
  if (name) params.push(`${PARAM_NAME}=${encodeName(name)}`);
  // Only an agent says so. A person's link stays byte-identical to the one the app has
  // always emitted, so nothing about the ordinary case changes shape for a field whose
  // absence already means "person".
  if (invite.kind !== CONNECTION_KIND_PERSON) params.push(`${PARAM_KIND}=${invite.kind}`);
  return `${INVITE_SCHEME}://${INVITE_HOST}?${params.join('&')}`;
}

/**
 * Parse a `loyaltycard://share?u=…&k=…&n=…` `uri`, or `null` if it is not a well-formed
 * share link (wrong scheme/host, or missing the required `u`/`k`). Tolerant of the
 * optional name being absent or undecodable — a bad name just yields a null
 * `displayName`, it never rejects the whole invite. The optional `t` is read the same
 * way: an unreadable claim is no claim, and the user is asked either way.
 */
export function parseInvite(uri: string): ConnectInvite | null {
  const trimmed = uri.trim();
  const prefix = `${INVITE_SCHEME}://${INVITE_HOST}?`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const query = trimmed.substring(prefix.length);
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    // Last duplicate wins, matching the app's `.toMap()`. A link carrying `u=` twice
    // is malformed either way; what matters is that both clients resolve it to the
    // same account rather than to two different ones.
    params.set(pair.substring(0, eq), pair.substring(eq + 1));
  }

  const uuid = params.get(PARAM_UUID);
  const fingerprint = params.get(PARAM_FINGERPRINT);
  if (!uuid || !fingerprint) return null;
  const rawName = params.get(PARAM_NAME);
  return {
    uuid,
    encKeyFingerprint: fingerprint,
    displayName: rawName === undefined ? null : decodeName(rawName),
    kind: connectionKindFromWire(params.get(PARAM_KIND)),
  };
}

function encodeName(name: string): string {
  return Buffer.from(name, 'utf8').toString('base64url');
}

function decodeName(encoded: string): string | null {
  const bytes = Buffer.from(encoded, 'base64url');
  // Node's base64 decoder skips what it cannot read instead of failing, so re-encode to
  // find out whether this was really base64url — the Kotlin side gets that for free
  // from `Base64.getUrlDecoder()` throwing.
  if (bytes.toString('base64url') !== encoded) return null;
  return bytes.toString('utf8');
}
