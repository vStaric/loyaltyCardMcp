import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectionKindFromWire } from './connectInvite.js';
import {
  EMPTY_ROSTER,
  withoutEvicted,
  withoutOrphans,
  type Connection,
  type Eviction,
  type Roster,
} from './roster.js';

const ROSTER_FILE = 'roster.json';

/**
 * Durable home of the sharing {@link Roster} — the port of `PrefsRosterStore`.
 *
 * Local is the source of truth for who this agent shares with. The file holds public
 * keys and uuids only, but it is still security-relevant: the pinned keys are what
 * make a later server-side key swap detectable, so it is written owner-only in the
 * owner-only config directory, and a **damaged** file is a loud failure rather than a
 * silent empty roster. The app can afford `getOrDefault(Roster())` there because a
 * user watching an empty Connections page will re-add their peers; an unattended agent
 * would instead quietly stop sharing with everyone and re-pin whatever the server
 * offered next.
 */
export class RosterStore {
  private cached: Roster | null = null;

  constructor(private readonly configDir: string) {}

  /** The current roster, or an empty one if nothing has been persisted yet. */
  load(): Roster {
    if (this.cached) return this.cached;
    let text: string;
    try {
      text = readFileSync(this.file(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (this.cached = EMPTY_ROSTER);
      throw new Error(`cannot read the roster at ${this.file()}: ${(e as Error).message}`);
    }
    return (this.cached = decodeRoster(text, this.file()));
  }

  /** Persist `roster` as the new source of truth. */
  save(roster: Roster): void {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const path = this.file();
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    this.cached = roster;
  }

  /** Read-modify-write: apply `transform` to the current roster and save the result. */
  update(transform: (roster: Roster) => Roster): Roster {
    const next = transform(this.load());
    this.save(next);
    return next;
  }

  private file(): string {
    return join(this.configDir, ROSTER_FILE);
  }
}

/**
 * Parse a persisted roster.
 *
 * Every field is checked because this file decides who our content keys get wrapped
 * to. An entry missing a key is dropped rather than repaired into something plausible —
 * inventing a member is the one failure this layer must not have.
 *
 * A `scopes` array written before lcm-hfd is **read and discarded**, and that is a
 * widening: a roster that recorded "shopping only" for someone now loads as a household
 * member sealed everything. It is the decision applied to the state that already
 * exists, not an accident of parsing — membership implies every scope, and a narrowing
 * this version cannot perform must not be honoured on the way in either, because it
 * would leave one member seeing less than another with nothing able to change it back.
 */
function decodeRoster(text: string, path: string): Roster {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`the roster at ${path} is not JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the roster at ${path} is not a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  const rawConnections = Array.isArray(o.connections) ? o.connections : [];
  const connections: Connection[] = [];
  for (const raw of rawConnections) {
    const connection = decodeConnection(raw);
    if (connection) connections.push(connection);
  }
  const handledRequestIds = (Array.isArray(o.handledRequestIds) ? o.handledRequestIds : []).filter(
    (id): id is number => typeof id === 'number' && Number.isSafeInteger(id),
  );
  const evictions: Eviction[] = [];
  for (const raw of Array.isArray(o.evictions) ? o.evictions : []) {
    const eviction = decodeEviction(raw);
    if (eviction) evictions.push(eviction);
  }
  // Two invariants of a *loaded* roster rather than of every path that ever edits one,
  // because this is a file: it can be hand-edited, half-written, or written by a version
  // that did not have them.
  //
  // An indirect entry is only ever as good as the connection that vouched for it, and
  // nothing outside `withoutConnection` guarantees that connection survived. And an
  // account a household evicted must not come back by being read off disk — that is the
  // subtract-last rule holding across a restart as well as across a sync pass (lcm-9m7).
  return {
    connections: withoutOrphans(withoutEvicted(connections, evictions)),
    handledRequestIds,
    evictions,
  };
}

/**
 * Parse one persisted eviction, or drop it.
 *
 * Unlike the wire form ({@link import('./connections.js').decodeShareDoc}) an undated
 * record here is dropped rather than read as "now": this file is one **we** wrote, so a
 * record with no usable time is corruption rather than an older peer's spelling, and
 * re-dating it on every load would make the tombstone drift later than the admissions it
 * is supposed to be compared against.
 */
function decodeEviction(raw: unknown): Eviction | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.uuid !== 'string' || o.uuid === '') return null;
  if (typeof o.at !== 'number' || !Number.isSafeInteger(o.at) || o.at < 0) return null;
  if (typeof o.by !== 'string' || typeof o.learnedFrom !== 'string') return null;
  return { uuid: o.uuid, at: o.at, by: o.by, learnedFrom: o.learnedFrom };
}

function decodeConnection(raw: unknown): Connection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const { uuid, signKey, encKey } = o;
  if (typeof uuid !== 'string' || typeof signKey !== 'string' || typeof encKey !== 'string') {
    return null;
  }
  return {
    uuid,
    displayName: typeof o.displayName === 'string' ? o.displayName : null,
    signKey,
    encKey,
    kind: connectionKindFromWire(typeof o.kind === 'string' ? o.kind : null),
    connectedAt: typeof o.connectedAt === 'number' && o.connectedAt >= 0 ? o.connectedAt : 0,
    // A roster written before evictions existed dates nothing, and an entry this agent
    // cannot date is one it cannot claim outranks an eviction (lcm-9m7). For the direct
    // connections that is no loss: they fall back to the accept this host recorded.
    admittedAt:
      typeof o.admittedAt === 'number' && o.admittedAt >= 0
        ? o.admittedAt
        : typeof o.learnedFrom === 'string' && o.learnedFrom !== ''
          ? 0
          : typeof o.connectedAt === 'number' && o.connectedAt >= 0
            ? o.connectedAt
            : 0,
    // Absent means direct, which is what every roster written before lcm-8lm holds and
    // the only safe reading of silence: an entry we cannot attribute to a peer is one
    // the operator is presumed to have approved, not one to attribute to nobody.
    learnedFrom: typeof o.learnedFrom === 'string' && o.learnedFrom !== '' ? o.learnedFrom : null,
  };
}
