import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectionKindFromWire } from './connectInvite.js';
import {
  ALL_SCOPES,
  EMPTY_ROSTER,
  resourceScopeFromWire,
  type Connection,
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
 * to. An entry missing a key, or holding a scope this version does not know, is
 * dropped with the reason named rather than repaired into something plausible —
 * inventing a grant is the one failure this layer must not have.
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
  return { connections, handledRequestIds };
}

function decodeConnection(raw: unknown): Connection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const { uuid, signKey, encKey } = o;
  if (typeof uuid !== 'string' || typeof signKey !== 'string' || typeof encKey !== 'string') {
    return null;
  }
  const scopes = Array.isArray(o.scopes)
    ? o.scopes
        .map((s) => resourceScopeFromWire(typeof s === 'string' ? s : null))
        .filter((s) => s !== null)
    : // A connection persisted before scopes existed granted both, which is what an
      // absent field has always meant; an *empty* list is a real answer and is kept.
      ALL_SCOPES;
  return {
    uuid,
    displayName: typeof o.displayName === 'string' ? o.displayName : null,
    signKey,
    encKey,
    scopes,
    kind: connectionKindFromWire(typeof o.kind === 'string' ? o.kind : null),
    connectedAt: typeof o.connectedAt === 'number' && o.connectedAt >= 0 ? o.connectedAt : 0,
  };
}
