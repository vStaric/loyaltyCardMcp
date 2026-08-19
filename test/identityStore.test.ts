import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isValidMnemonic } from '../src/crypto/bip39.js';
import { IdentityStore } from '../src/crypto/identityStore.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { RESOURCE_USER, SyncStateStore } from '../src/sync/syncState.js';

/**
 * The on-disk half of the peer's identity.
 *
 * The app seals its entropy with a hardware-backed Keystore key; there is no such
 * thing on a laptop or a hosted box, so file permissions are the whole protection and
 * are asserted here rather than assumed. The other thing worth pinning is the refusal
 * to derive from a phrase that does not checksum: a corrupted file must fail loudly,
 * because deriving from it produces a *valid identity for a different account* that
 * then fails every share with a confusing "no wrapped key for recipient".
 */
let sodium: SodiumCrypto;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-test-'));
  dirs.push(dir);
  return join(dir, 'config');
}

describe('IdentityStore', () => {
  it('mints an identity on first use and loads the same one after', () => {
    const dir = tempDir();
    expect(new IdentityStore(dir, sodium).exists()).toBe(false);

    const first = new IdentityStore(dir, sodium).getOrCreate();
    expect(first.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const reopened = new IdentityStore(dir, sodium);
    expect(reopened.exists()).toBe(true);
    expect(reopened.getOrCreate().uuid).toBe(first.uuid);
  });

  it('does not mint an identity just to answer who we are', () => {
    const dir = tempDir();
    expect(new IdentityStore(dir, sodium).uuidIfPresent()).toBeNull();
    expect(new IdentityStore(dir, sodium).exists()).toBe(false);
  });

  it('stores the phrase owner-only in an owner-only directory', () => {
    const dir = tempDir();
    new IdentityStore(dir, sodium).getOrCreate();
    // Nothing else protects this file, so the mode is the security boundary.
    expect(statSync(join(dir, 'identity.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('exports a valid recovery phrase that reproduces the same account', () => {
    const dir = tempDir();
    const store = new IdentityStore(dir, sodium);
    const uuid = store.getOrCreate().uuid;
    const phrase = store.exportMnemonic();
    expect(isValidMnemonic(phrase)).toBe(true);

    const elsewhere = new IdentityStore(tempDir(), sodium);
    expect(elsewhere.importMnemonic(phrase).uuid).toBe(uuid);
  });

  it('replaces the host identity on import', () => {
    const dir = tempDir();
    const store = new IdentityStore(dir, sodium);
    const original = store.getOrCreate().uuid;
    const other = new IdentityStore(tempDir(), sodium);
    other.getOrCreate();

    const adopted = store.importMnemonic(other.exportMnemonic());
    expect(adopted.uuid).not.toBe(original);
    expect(new IdentityStore(dir, sodium).getOrCreate().uuid).toBe(adopted.uuid);
  });

  it('refuses a phrase that fails its checksum rather than deriving a stranger', () => {
    const store = new IdentityStore(tempDir(), sodium);
    expect(() =>
      store.importMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon ' +
          'abandon abandon abandon abandon',
      ),
    ).toThrow(/recovery phrase/);
    expect(store.exists()).toBe(false);
  });

  it('refuses a corrupted or unreadable identity file rather than guessing', () => {
    const dir = tempDir();
    new IdentityStore(dir, sodium).getOrCreate();
    const file = join(dir, 'identity.json');

    writeFileSync(file, '{"format":1,"mnemonic":"abandon abandon nonsense"}');
    expect(() => new IdentityStore(dir, sodium).getOrCreate()).toThrow(/valid recovery phrase/);

    writeFileSync(file, 'not json at all');
    expect(() => new IdentityStore(dir, sodium).getOrCreate()).toThrow(/unreadable/);

    writeFileSync(file, '{"format":99,"mnemonic":"x"}');
    expect(() => new IdentityStore(dir, sodium).getOrCreate()).toThrow(/format 99/);
  });

  it('erases only this host’s copy, and says whether there was one', () => {
    const dir = tempDir();
    const store = new IdentityStore(dir, sodium);
    expect(store.erase()).toBe(false);
    store.getOrCreate();
    expect(store.erase()).toBe(true);
    expect(store.exists()).toBe(false);
  });

  it('leaves no temp file behind after a write', () => {
    const dir = tempDir();
    new IdentityStore(dir, sodium).getOrCreate();
    expect(() => readFileSync(join(dir, 'identity.json.tmp'))).toThrow();
  });
});

describe('SyncStateStore', () => {
  it('starts at zero and remembers what the server reported', () => {
    const dir = tempDir();
    const store = new SyncStateStore(dir);
    expect(store.lastVer(RESOURCE_USER)).toBe(0);
    store.setLastVer(RESOURCE_USER, 4);
    expect(new SyncStateStore(dir).lastVer(RESOURCE_USER)).toBe(4);
  });

  it('treats an unreadable state file as knowing nothing rather than failing', () => {
    // This file holds no secrets and no authority — the server's version wins — so it
    // is never worth failing a command over.
    const dir = tempDir();
    new SyncStateStore(dir).setLastVer(RESOURCE_USER, 3);
    writeFileSync(join(dir, 'sync-state.json'), 'garbage{');
    expect(new SyncStateStore(dir).lastVer(RESOURCE_USER)).toBe(0);
  });

  it('ignores entries that are not plausible versions', () => {
    const dir = tempDir();
    new SyncStateStore(dir).setLastVer(RESOURCE_USER, 1);
    writeFileSync(join(dir, 'sync-state.json'), '{"user":-2,"cards":"x","share":7}');
    const store = new SyncStateStore(dir);
    expect(store.lastVer(RESOURCE_USER)).toBe(0);
    expect(store.lastVer('cards')).toBe(0);
    expect(store.lastVer('share')).toBe(7);
  });
});
