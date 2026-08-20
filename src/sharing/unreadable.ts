/**
 * Why one connection's resource did not make it into a view.
 *
 * Shared by the card and shopping services because it is one vocabulary, not two: both
 * fetch a peer's envelope, verify it against a **pinned** key and try to open it, and
 * both have to answer the same question afterwards — "did they not give me this, or is
 * there nothing there?"
 *
 * That distinction is the reason this type exists at all rather than a resource simply
 * being absent from a result. A connection that granted the cards but not the shopping
 * list (lc-chp) publishes a slice with no content key wrapped to us; report that as an
 * empty list and the agent tells the user they have nothing to buy, which is a sentence
 * they will act on and which is false. Two copies of this vocabulary would drift, and
 * the drift would show up as one resource reporting the refusal and the other not.
 */
export type UnreadableReason =
  /** Published, verified — and no content key wrapped to us. The scope refusal (lc-chp). */
  | 'not_granted'
  /** Nothing published at that address at all. */
  | 'not_published'
  /** Unsigned, signed by someone else, or failing the pinned key. A trust failure. */
  | 'not_verified'
  /** A key was wrapped to us and still would not open the body. */
  | 'undecryptable'
  /** Decrypted, but not something this version can parse. */
  | 'malformed'
  /** The fetch itself failed — network, timeout, server error. */
  | 'unreachable';

/** One connection's resource that could not be read, and the reason in full. */
export interface UnreadableSource {
  readonly uuid: string;
  readonly displayName: string | null;
  readonly reason: UnreadableReason;
  /** Long form, for a caller that has to explain the refusal to a person. */
  readonly detail: string;
}
