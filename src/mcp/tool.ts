/**
 * The transport-independent shape of one MCP tool: what it is called, what it takes,
 * and what running it does.
 *
 * Kept separate from the server wiring so the tools can be exercised directly in
 * tests — the interesting behaviour of this surface is *what it refuses and how it
 * says so*, and that must not be reachable only through a stdio session.
 */
export interface ToolDefinition {
  readonly name: string;
  /** Human-facing label for a tool picker. */
  readonly title: string;
  /**
   * What the tool does — read by a model, so it states the limits too. A tool whose
   * description omits that it cannot edit the user's cards invites exactly the call
   * that has to be refused.
   */
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly inputSchema: Record<string, unknown>;
  /** Hints for a host deciding how to present the call. Advisory, never enforcement. */
  readonly annotations?: ToolAnnotations;
  /** Run it. The resolved value is serialized as the tool result. */
  readonly run: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * A tool result that is **not** JSON text: the content blocks to return verbatim.
 *
 * Almost every tool here answers with a value the server serializes as JSON, which is
 * the right shape for facts about cards and lists. A photo is not a fact about a card;
 * it is bytes, and MCP has a content type for exactly that. Returning a class the
 * server recognises — rather than sniffing a plain object for a `content` key — keeps
 * "these are content blocks" impossible to say by accident, and impossible to trigger
 * from a card whose notes happen to be shaped like one.
 */
export class ToolContent {
  constructor(readonly blocks: readonly ToolContentBlock[]) {}
}

/** The content blocks a tool may return directly. */
export type ToolContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** An argument was missing or the wrong type. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`${key} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * A string argument that may be absent or explicitly `null`.
 *
 * The three-way answer is the point: `undefined` means the caller said nothing (leave
 * it alone), `null` means the caller said "clear it". A patch that could not tell
 * those apart would blank every field the caller did not mention.
 */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string or null`);
  return value;
}

/** The arguments object of a tool call, or an empty one when the caller sent none. */
export function argsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolInputError('tool arguments must be an object');
  }
  return raw as Record<string, unknown>;
}
