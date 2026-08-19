import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_NAME, loadConfig } from '../src/config.js';
import type { Envelope } from '../src/crypto/envelope.js';
import { identityFromSeed, type Identity } from '../src/crypto/identity.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import { TolarPeer } from '../src/peer.js';
import { CONNECTION_KIND_AGENT, parseInvite } from '../src/sharing/connectInvite.js';
import { fingerprintMatches } from '../src/sharing/keyFingerprint.js';
import { decodeShareCode } from '../src/sharing/shareCode.js';
import { RESOURCE_USER, SyncStateStore } from '../src/sync/syncState.js';
import type { TolarApi } from '../src/sync/tolarApi.js';
import type {
  PairingCodeIssuedDto,
  PairingCodeResolvedDto,
  PairingPayloadDto,
  ShareRequestBody,
  ShareRequestsViewDto,
  ShareResponseViewDto,
  ShoppingListViewDto,
  UserProfileDto,
  UserPutBody,
} from '../src/sync/wire.js';

/**
 * The peer facade: registering the user row, and the pairing material the user
 * actually acts on.
 *
 * The pairing assertions are the point. The share code and the link have to carry the
 * *live* encryption key's fingerprint, because that fingerprint is the only thing
 * standing between the user and a server that swapped our key — if it were stale or
 * truncated, the accept screen's comparison would pass while pinning the wrong key.
 */
let sodium: SodiumCrypto;
let identity: Identity;
const dirs: string[] = [];

beforeAll(async () => {
  sodium = await initSodium();
  identity = identityFromSeed(
    Uint8Array.from({ length: 64 }, (_, i) => i),
    sodium,
  );
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tolar-mcp-peer-'));
  dirs.push(dir);
  return dir;
}

/** An in-memory backend that records what the peer asked it to do. */
class FakeApi implements TolarApi {
  user: UserProfileDto | null = null;
  readonly userPuts: Array<{ body: UserPutBody; ver: number }> = [];
  readonly pairingPayloads: PairingPayloadDto[] = [];
  storedVer = 0;

  async getUser(): Promise<UserProfileDto | null> {
    return this.user;
  }

  async putUser(_uuid: string, body: UserPutBody, ver: number): Promise<number> {
    this.userPuts.push({ body, ver });
    this.storedVer = ver;
    this.user = { signKey: body.signKey, encKey: body.encKey, displayNameEnc: null, ver };
    return ver;
  }

  async postPairingCode(body: PairingPayloadDto): Promise<PairingCodeIssuedDto> {
    this.pairingPayloads.push(body);
    return { code: '4F9K-2C7X', expiresAt: null, maxUses: 1 };
  }

  // Not exercised here; the peer core's remaining surface belongs to the tool beads.
  async deleteUser(): Promise<void> {}
  async getCards(): Promise<Envelope | null> {
    return null;
  }
  async putCards(): Promise<number> {
    return 1;
  }
  async getShoppingList(): Promise<ShoppingListViewDto> {
    return { listId: 'l', slices: [] };
  }
  async putShoppingSlice(): Promise<number> {
    return 1;
  }
  async putBlob(): Promise<void> {}
  async getBlob(): Promise<Uint8Array | null> {
    return null;
  }
  async postRequestShare(_uuid: string, _body: ShareRequestBody): Promise<number> {
    return 1;
  }
  async getRequestShare(): Promise<ShareRequestsViewDto> {
    return { originUuid: 'o', requests: [] };
  }
  async putShareResponse(): Promise<number> {
    return 1;
  }
  async getShareResponse(): Promise<ShareResponseViewDto | null> {
    return null;
  }
  async postPairingResolve(): Promise<PairingCodeResolvedDto | null> {
    return null;
  }
  async getShare(): Promise<Envelope | null> {
    return null;
  }
  async putShare(): Promise<number> {
    return 1;
  }
}

function peerWith(api: FakeApi, displayName: string | null = 'Test agent') {
  const configDir = tempDir();
  const config = { configDir, baseUrl: 'https://tolar.example', displayName };
  return {
    peer: TolarPeer.from(config, identity, sodium, api, new SyncStateStore(configDir)),
    configDir,
  };
}

describe('TolarPeer.ensureUserRegistered', () => {
  it('publishes the user row at ver 1 on a fresh account', async () => {
    const api = new FakeApi();
    const { peer, configDir } = peerWith(api);

    expect(await peer.ensureUserRegistered()).toBe(1);
    expect(api.userPuts).toHaveLength(1);
    expect(api.userPuts[0]!.ver).toBe(1);
    expect(Buffer.from(api.userPuts[0]!.body.signKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(api.userPuts[0]!.body.encKey, 'base64')).toHaveLength(32);
    expect(new SyncStateStore(configDir).lastVer(RESOURCE_USER)).toBe(1);
  });

  it('leaves the display name off the server, where there is no cleartext for it', async () => {
    const api = new FakeApi();
    const { peer } = peerWith(api, 'Test agent');
    await peer.ensureUserRegistered();
    expect(api.userPuts[0]!.body.displayNameEnc).toBeNull();
  });

  it('does not re-publish a row the server already has', async () => {
    const api = new FakeApi();
    const { peer, configDir } = peerWith(api);
    api.user = { signKey: 'SK', encKey: 'EK', displayNameEnc: null, ver: 5 };

    expect(await peer.ensureUserRegistered()).toBe(5);
    expect(api.userPuts).toHaveLength(0);
    // Adopting the server's version is what stops the next write being a guaranteed 409.
    expect(new SyncStateStore(configDir).lastVer(RESOURCE_USER)).toBe(5);
  });
});

describe('TolarPeer.pair', () => {
  it('publishes the user row before handing out an invite', async () => {
    // A printed invite the app cannot resolve wastes the user's time at exactly the
    // moment they are trying to trust us.
    const api = new FakeApi();
    const { peer } = peerWith(api);
    await peer.pair();
    expect(api.userPuts).toHaveLength(1);
  });

  it('carries the live encryption key’s full fingerprint in every form', async () => {
    const { peer } = peerWith(new FakeApi());
    const material = await peer.pair();

    expect(material.invite.uuid).toBe(identity.uuid);
    expect(fingerprintMatches(identity.encPublicKey, material.invite.encKeyFingerprint)).toBe(true);

    const fromLink = parseInvite(material.uri)!;
    expect(fromLink.uuid).toBe(identity.uuid);
    expect(fromLink.encKeyFingerprint).toBe(material.invite.encKeyFingerprint);

    const fromCode = decodeShareCode(material.shareCode!)!;
    expect(fromCode.uuid).toBe(identity.uuid);
    // The code carries the whole fingerprint, not a prefix — it feeds the identical
    // TOFU check the link does.
    expect(fromCode.encKeyFingerprint).toBe(material.invite.encKeyFingerprint);
  });

  it('declares the agent kind in the link, where the app reads the pre-tick from', async () => {
    const { peer } = peerWith(new FakeApi());
    const material = await peer.pair();
    expect(material.invite.kind).toBe(CONNECTION_KIND_AGENT);
    expect(parseInvite(material.uri)?.kind).toBe(CONNECTION_KIND_AGENT);
    expect(material.uri).toContain('t=agent');
  });

  it('offers a safety number matching the encryption key', async () => {
    const { peer } = peerWith(new FakeApi());
    const material = await peer.pair();
    expect(material.safetyNumber.replace(/ /g, '')).toHaveLength(64);
    expect(material.safetyNumber.replace(/ /g, '')).toBe(
      Buffer.from(
        await import('node:crypto').then((c) =>
          c.createHash('sha256').update(identity.encPublicKey).digest(),
        ),
      ).toString('hex'),
    );
  });

  it('always produces an encodable share code', async () => {
    // Our uuid is canonical and our fingerprint full-width, so a null here would be a
    // bug in this peer rather than bad input.
    const { peer } = peerWith(new FakeApi());
    expect((await peer.pair()).shareCode).not.toBeNull();
  });
});

describe('TolarPeer.mintPairingCode', () => {
  it('registers first and mints against our own uuid and fingerprint', async () => {
    const api = new FakeApi();
    const { peer } = peerWith(api);
    const issued = await peer.mintPairingCode();

    expect(issued.code).toBe('4F9K-2C7X');
    expect(api.userPuts).toHaveLength(1);
    const payload = api.pairingPayloads[0]!;
    expect(payload.uuid).toBe(identity.uuid);
    expect(fingerprintMatches(identity.encPublicKey, payload.encKeyFingerprint)).toBe(true);
    expect(payload.kind).toBe(CONNECTION_KIND_AGENT);
  });
});

describe('loadConfig', () => {
  it('requires a base url rather than guessing one', () => {
    // A baked-in default would publish this peer's identity to whatever host it named.
    expect(() => loadConfig({}, {})).toThrow(/TOLAR_API_URL/);
  });

  it('refuses a plaintext hop to anywhere but localhost', () => {
    expect(() => loadConfig({}, { TOLAR_API_URL: 'http://tolar.example' })).toThrow(/https/);
    expect(loadConfig({}, { TOLAR_API_URL: 'http://localhost:8080' }).baseUrl).toBe(
      'http://localhost:8080',
    );
    expect(loadConfig({}, { TOLAR_API_URL: 'https://tolar.example' }).baseUrl).toBe(
      'https://tolar.example',
    );
  });

  it('rejects something that is not a url at all', () => {
    expect(() => loadConfig({}, { TOLAR_API_URL: 'tolar.example' })).toThrow(/valid URL/);
  });

  it('takes the config dir from the environment, and flags over it', () => {
    const env = { TOLAR_API_URL: 'https://tolar.example', TOLAR_MCP_HOME: '/srv/agent' };
    expect(loadConfig({}, env).configDir).toBe('/srv/agent');
    expect(loadConfig({ configDir: '/tmp/other' }, env).configDir).toBe('/tmp/other');
  });

  it('falls back to XDG and then to ~/.config', () => {
    const env = { TOLAR_API_URL: 'https://tolar.example', XDG_CONFIG_HOME: '/xdg' };
    expect(loadConfig({}, env).configDir).toBe('/xdg/tolar-mcp');
    expect(loadConfig({}, { TOLAR_API_URL: 'https://tolar.example' }).configDir).toMatch(
      /\.config\/tolar-mcp$/,
    );
  });

  it('names the agent honestly by default', () => {
    const env = { TOLAR_API_URL: 'https://tolar.example' };
    expect(loadConfig({}, env).displayName).toBe(DEFAULT_DISPLAY_NAME);
    expect(loadConfig({}, { ...env, TOLAR_AGENT_NAME: 'Shopping helper' }).displayName).toBe(
      'Shopping helper',
    );
    expect(loadConfig({ displayName: null }, env).displayName).toBeNull();
  });
});
