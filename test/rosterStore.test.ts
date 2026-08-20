import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  grants,
  signingKeyOf,
  toRecipient,
  type Connection,
} from '../src/sharing/roster.js';
import { RosterStore } from '../src/sharing/rosterStore.js';

/**
 * The roster file — who this agent shares with, and the keys it pinned to them.
 *
 * The reads here are security decisions, not preferences: this file is what a content
 * key gets wrapped to, and the pinned signing key is the only thing that would catch a
 * server serving somebody else's card list. So a damaged file fails loudly rather than
 * defaulting to "connected to nobody", which an unattended agent would silently accept
 * and then re-pin whatever the server offered next.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-roster-'));
  dirs.push(dir);
  return dir;
}

const connection: Connection = {
  uuid: 'user-1',
  displayName: 'Vid',
  signKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
  encKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
  scopes: ['cards'],
  kind: 'person',
  connectedAt: 1_800_000_000_000,
};

describe('RosterStore', () => {
  it('is empty before anything is written', () => {
    expect(new RosterStore(tempDir()).load()).toEqual({ connections: [], handledRequestIds: [] });
  });

  it('round-trips a connection', () => {
    const dir = tempDir();
    new RosterStore(dir).save({ connections: [connection], handledRequestIds: [7] });
    expect(new RosterStore(dir).load()).toEqual({
      connections: [connection],
      handledRequestIds: [7],
    });
  });

  it('writes owner-only, in an owner-only directory', () => {
    const dir = tempDir();
    new RosterStore(dir).save({ connections: [connection], handledRequestIds: [] });
    expect(statSync(join(dir, 'roster.json')).mode & 0o777).toBe(0o600);
  });

  it('replaces a connection by uuid rather than accumulating duplicates', () => {
    const dir = tempDir();
    const store = new RosterStore(dir);
    store.save({ connections: [connection], handledRequestIds: [] });
    store.update((r) => ({
      ...r,
      connections: [{ ...connection, displayName: 'Renamed' }],
    }));
    expect(new RosterStore(dir).load().connections).toHaveLength(1);
  });

  it('reads a connection written before scopes existed as granting both', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'roster.json'),
      JSON.stringify({ connections: [{ uuid: 'u', signKey: 'a', encKey: 'b' }] }),
    );
    expect(new RosterStore(dir).load().connections[0]!.scopes).toEqual(ALL_SCOPES);
  });

  it('keeps an explicitly empty grant — connected, sharing nothing', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'roster.json'),
      JSON.stringify({ connections: [{ uuid: 'u', signKey: 'a', encKey: 'b', scopes: [] }] }),
    );
    expect(new RosterStore(dir).load().connections[0]!.scopes).toEqual([]);
  });

  it('drops a scope this version does not know instead of guessing at it', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'roster.json'),
      JSON.stringify({
        connections: [{ uuid: 'u', signKey: 'a', encKey: 'b', scopes: ['cards', 'photos'] }],
      }),
    );
    expect(new RosterStore(dir).load().connections[0]!.scopes).toEqual(['cards']);
  });

  it('drops an entry with no key rather than keeping a connection it cannot seal to', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'roster.json'), JSON.stringify({ connections: [{ uuid: 'u' }] }));
    expect(new RosterStore(dir).load().connections).toEqual([]);
  });

  it('throws on a damaged file instead of reporting an empty roster', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'roster.json'), '{ not json');
    expect(() => new RosterStore(dir).load()).toThrow(/not JSON/);
  });

  it('leaves the previous file intact if a write is interrupted', () => {
    // The write is a temp-file rename, so a reader never sees half a roster.
    const dir = tempDir();
    const store = new RosterStore(dir);
    store.save({ connections: [connection], handledRequestIds: [] });
    const before = readFileSync(join(dir, 'roster.json'), 'utf8');
    expect(() => store.save({ connections: [connection], handledRequestIds: [] })).not.toThrow();
    expect(readFileSync(join(dir, 'roster.json'), 'utf8')).toBe(before);
  });
});

describe('connection helpers', () => {
  it('answers the one question the wrap layer asks', () => {
    expect(grants(connection, 'cards')).toBe(true);
    expect(grants(connection, 'shopping')).toBe(false);
  });

  it('turns a pinned key straight into an envelope recipient', () => {
    expect(toRecipient(connection)).toEqual({
      uuid: 'user-1',
      x25519PublicKey: new Uint8Array(32).fill(2),
    });
  });

  it('refuses a malformed pinned key rather than yielding short key bytes', () => {
    // Node's base64 decoder skips what it cannot read, so this would otherwise produce
    // a key that wraps to nobody — sharing that silently stops working.
    expect(() => signingKeyOf({ ...connection, signKey: 'not base64!!' })).toThrow(/malformed/);
  });
});
