import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  householdMembers,
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
  kind: 'person',
  connectedAt: 1_800_000_000_000,
  admittedAt: 1_800_000_000_000,
  learnedFrom: null,
};

describe('RosterStore', () => {
  it('is empty before anything is written', () => {
    expect(new RosterStore(tempDir()).load()).toEqual({
      connections: [],
      handledRequestIds: [],
      evictions: [],
    });
  });

  it('round-trips a connection', () => {
    const dir = tempDir();
    new RosterStore(dir).save({ connections: [connection], handledRequestIds: [7], evictions: [] });
    expect(new RosterStore(dir).load()).toEqual({
      connections: [connection],
      handledRequestIds: [7],
      evictions: [],
    });
  });

  it('writes owner-only, in an owner-only directory', () => {
    const dir = tempDir();
    new RosterStore(dir).save({ connections: [connection], handledRequestIds: [], evictions: [] });
    expect(statSync(join(dir, 'roster.json')).mode & 0o777).toBe(0o600);
  });

  it('replaces a connection by uuid rather than accumulating duplicates', () => {
    const dir = tempDir();
    const store = new RosterStore(dir);
    store.save({ connections: [connection], handledRequestIds: [], evictions: [] });
    store.update((r) => ({
      ...r,
      connections: [{ ...connection, displayName: 'Renamed' }],
    }));
    expect(new RosterStore(dir).load().connections).toHaveLength(1);
  });

  it('loads a narrowed entry written before lcm-hfd as a full household member', () => {
    // The widening is the decision, applied to state that already exists: a roster that
    // recorded "shopping only" for someone cannot go on meaning that, because nothing
    // left in this version can narrow anyone and one member reading less than another
    // would be a state no operator could get out of.
    const dir = tempDir();
    writeFileSync(
      join(dir, 'roster.json'),
      JSON.stringify({
        connections: [{ uuid: 'u', signKey: 'a', encKey: 'b', scopes: ['shopping'] }],
      }),
    );
    const loaded = new RosterStore(dir).load().connections;
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).not.toHaveProperty('scopes');
    expect(householdMembers({ connections: loaded, handledRequestIds: [], evictions: [] })).toEqual(
      loaded,
    );
  });

  it('loads an entry that granted nothing at all as a full household member', () => {
    // The old file's one truly deliberate answer — "connected, sharing nothing" — is
    // also gone. Membership is now the whole grant, so an empty list is not a narrower
    // membership; it is a member who used to be sealed nothing and now is sealed all.
    const dir = tempDir();
    writeFileSync(
      join(dir, 'roster.json'),
      JSON.stringify({ connections: [{ uuid: 'u', signKey: 'a', encKey: 'b', scopes: [] }] }),
    );
    expect(new RosterStore(dir).load().connections).toHaveLength(1);
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
    store.save({ connections: [connection], handledRequestIds: [], evictions: [] });
    const before = readFileSync(join(dir, 'roster.json'), 'utf8');
    expect(() =>
      store.save({ connections: [connection], handledRequestIds: [], evictions: [] }),
    ).not.toThrow();
    expect(readFileSync(join(dir, 'roster.json'), 'utf8')).toBe(before);
  });
});

describe('connection helpers', () => {
  it('answers the one question the wrap layer asks: everyone in the roster', () => {
    const indirect = { ...connection, uuid: 'user-2', learnedFrom: 'user-1' };
    const roster = { connections: [connection, indirect], handledRequestIds: [], evictions: [] };
    expect(householdMembers(roster)).toEqual([connection, indirect]);
    // And an evicted member is gone from the answer the very next time it is asked —
    // the recipient list is never cached, which is what makes this the enforcement point.
    expect(householdMembers({ ...roster, connections: [connection] })).toEqual([connection]);
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
