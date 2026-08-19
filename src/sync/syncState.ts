import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'sync-state.json';

/** The resource whose last-written version is being tracked. */
export const RESOURCE_USER = 'user';
export const RESOURCE_CARDS = 'cards';
export const RESOURCE_SHARE = 'share';
export const RESOURCE_SHOPPING = 'shoppinglist';

/**
 * Remembers the last version this peer wrote for each resource — the port of the
 * bookkeeping half of `sync/SyncStore.kt`.
 *
 * Every envelope write is a compare-and-set on a strictly increasing `ver`, so a peer
 * that forgets what it last wrote gets one `stale_version` and has to re-read. Keeping
 * it on disk turns a restart from a guaranteed conflict into a no-op.
 *
 * It is a **cache, not a source of truth**: the server's stored version wins, and every
 * caller here overwrites the local number with what the server returned.
 */
export class SyncStateStore {
  private state: Record<string, number> | null = null;

  constructor(private readonly configDir: string) {}

  /** The last version stored for `resource`, or 0 when this peer has never written it. */
  lastVer(resource: string): number {
    return this.load()[resource] ?? 0;
  }

  /** Record the version the server reported after a successful write. */
  setLastVer(resource: string, ver: number): void {
    const state = this.load();
    state[resource] = ver;
    this.persist(state);
  }

  private load(): Record<string, number> {
    if (this.state) return this.state;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file(), 'utf8'));
    } catch {
      // Missing or unreadable is the same answer: we know nothing, so start from zero
      // and take one stale-version round trip. This file holds no secrets and no
      // authority, so it is never worth failing a command over.
      return (this.state = {});
    }
    const out: Record<string, number> = {};
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          out[key] = value;
        }
      }
    }
    return (this.state = out);
  }

  private persist(state: Record<string, number>): void {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const path = this.file();
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  private file(): string {
    return join(this.configDir, STATE_FILE);
  }
}
