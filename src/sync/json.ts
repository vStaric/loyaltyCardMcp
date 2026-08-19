/**
 * Minimal structural decoding for untrusted JSON off the wire.
 *
 * The Android client gets this from `kotlinx.serialization`, which refuses a payload
 * that does not fit the declared shape. TypeScript's types are erased at runtime, so
 * `JSON.parse() as UserProfileDto` would assert a shape rather than check one and let
 * an `undefined` where a base64 key belongs travel all the way into a signature
 * computation. These helpers keep the check where the bytes arrive.
 *
 * Unknown fields are ignored, matching the client's `ignoreUnknownKeys = true`: the
 * server is allowed to grow.
 */

/** A field was missing or the wrong type in a server response. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new DecodeError(`${what}: not JSON (${(e as Error).message})`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError(`${what}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function str(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new DecodeError(`${what}.${key}: expected a string`);
  return v;
}

export function optStr(o: Record<string, unknown>, key: string, what: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new DecodeError(`${what}.${key}: expected a string or null`);
  return v;
}

export function int(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new DecodeError(`${what}.${key}: expected an integer`);
  }
  return v;
}

export function intOr(
  o: Record<string, unknown>,
  key: string,
  fallback: number,
  what: string,
): number {
  return o[key] === undefined || o[key] === null ? fallback : int(o, key, what);
}

export function boolOr(
  o: Record<string, unknown>,
  key: string,
  fallback: boolean,
  what: string,
): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new DecodeError(`${what}.${key}: expected a boolean`);
  return v;
}

export function obj(
  o: Record<string, unknown>,
  key: string,
  what: string,
): Record<string, unknown> {
  const v = o[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DecodeError(`${what}.${key}: expected an object`);
  }
  return v as Record<string, unknown>;
}

export function optObj(
  o: Record<string, unknown>,
  key: string,
  what: string,
): Record<string, unknown> | null {
  return o[key] === undefined || o[key] === null ? null : obj(o, key, what);
}

export function arr(o: Record<string, unknown>, key: string, what: string): unknown[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DecodeError(`${what}.${key}: expected an array`);
  return v;
}

export function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DecodeError(`${what}: expected an object`);
  }
  return v as Record<string, unknown>;
}

/** A `Map<String, String>` field — the envelope's per-recipient wrapped keys. */
export function stringMap(
  o: Record<string, unknown>,
  key: string,
  what: string,
): Record<string, string> {
  const v = o[key];
  if (v === undefined || v === null) return {};
  const source = asObject(v, `${what}.${key}`);
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(source)) {
    if (typeof value !== 'string') {
      throw new DecodeError(`${what}.${key}.${k}: expected a string`);
    }
    out[k] = value;
  }
  return out;
}
