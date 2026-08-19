import { EnvelopeCrypto } from './crypto/envelopeCrypto.js';
import type { Identity } from './crypto/identity.js';
import { IdentityStore } from './crypto/identityStore.js';
import { initSodium, type SodiumCrypto } from './crypto/sodium.js';
import { CONNECTION_KIND_AGENT, inviteToUri, type ConnectInvite } from './sharing/connectInvite.js';
import { fingerprintOf, safetyNumber } from './sharing/keyFingerprint.js';
import { encodeShareCode } from './sharing/shareCode.js';
import { HttpTolarApi } from './sync/httpTolarApi.js';
import { RequestSigner } from './sync/requestSigner.js';
import { RESOURCE_USER, SyncStateStore } from './sync/syncState.js';
import type { TolarApi } from './sync/tolarApi.js';
import type { PairingCodeIssuedDto } from './sync/wire.js';
import { loadConfig, type PeerConfig } from './config.js';

/**
 * This agent as an ordinary Tolar peer: its own identity, its own envelope crypto, its
 * own REST client (PRD-agent-connection §2, §7.1).
 *
 * Nothing here is agent-specific machinery. It is the same peer core the app runs,
 * ported, which is the whole design: the Tolar server gains no endpoint and learns
 * nothing new — one more account publishing envelopes it cannot read.
 *
 * The tool surface (`list_shopping`, `add_card`, …) is deliberately not here; it is
 * built on top of this in the shopping-list and card beads.
 */
export class TolarPeer {
  private constructor(
    readonly config: PeerConfig,
    readonly identity: Identity,
    readonly sodium: SodiumCrypto,
    readonly api: TolarApi,
    readonly crypto: EnvelopeCrypto,
    private readonly state: SyncStateStore,
  ) {}

  /**
   * Load (or, on first run, mint) this peer's identity and wire it to the backend.
   *
   * Minting on first run is the right default for an agent: there is no user to prompt,
   * and the identity is worthless to anyone until the user accepts it. The seed is the
   * agent's own and never the user's — see {@link IdentityStore} for what protects it
   * and what does not.
   */
  static async open(
    overrides: Partial<PeerConfig> = {},
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<TolarPeer> {
    const config = loadConfig(overrides, env);
    const sodium = await initSodium();
    const identity = new IdentityStore(config.configDir, sodium).getOrCreate();
    const signer = new RequestSigner(identity.uuid, identity.signingKeyPair.secretKey, sodium);
    const api = new HttpTolarApi(config.baseUrl, signer);
    return new TolarPeer(
      config,
      identity,
      sodium,
      api,
      new EnvelopeCrypto(sodium),
      new SyncStateStore(config.configDir),
    );
  }

  /** Assemble a peer from parts — the seam the tests and future tool beads build on. */
  static from(
    config: PeerConfig,
    identity: Identity,
    sodium: SodiumCrypto,
    api: TolarApi,
    state: SyncStateStore = new SyncStateStore(config.configDir),
  ): TolarPeer {
    return new TolarPeer(config, identity, sodium, api, new EnvelopeCrypto(sodium), state);
  }

  /**
   * Publish this peer's `user` row if the server does not already have it. The first
   * PUT is the trust-on-first-use key bind; without it the server cannot resolve our
   * signing key to verify any envelope, so this must run before any envelope push and
   * before a recipient can resolve our invite.
   *
   * `displayNameEnc` is opaque ciphertext when it is anything — the server keeps no
   * cleartext name — so this peer leaves it unset and puts its name in the invite link,
   * which is where the app reads it from anyway.
   */
  async ensureUserRegistered(displayNameEnc: string | null = null): Promise<number> {
    const existing = await this.api.getUser(this.identity.uuid);
    if (existing) {
      this.state.setLastVer(RESOURCE_USER, existing.ver);
      return existing.ver;
    }
    const ver = this.state.lastVer(RESOURCE_USER) + 1;
    const stored = await this.api.putUser(
      this.identity.uuid,
      {
        signKey: b64(this.identity.signPublicKey),
        encKey: b64(this.identity.encPublicKey),
        displayNameEnc,
      },
      ver,
    );
    this.state.setLastVer(RESOURCE_USER, stored);
    return stored;
  }

  /**
   * The connect invitation for this peer: our uuid, the fingerprint of our encryption
   * key, our display name, and the `agent` claim.
   *
   * That claim is **not a security control** and this code must not pretend otherwise
   * (PRD-agent-connection §7.2). It is self-declared — a peer could say it was a person
   * — and it only pre-ticks a box on the app's accept screen. What the roster records
   * is what the *user* confirmed there. It is set here because the honest answer is
   * "agent" and the user deserves to see it, not because anything downstream trusts it.
   */
  connectInvite(): ConnectInvite {
    return {
      uuid: this.identity.uuid,
      encKeyFingerprint: fingerprintOf(this.identity.encPublicKey),
      displayName: this.config.displayName,
      kind: CONNECTION_KIND_AGENT,
    };
  }

  /**
   * Everything the user needs to add this agent from the app, with the user row
   * published first so their key fetch resolves.
   *
   * Registration is awaited rather than best-effort: a printed invite the app cannot
   * resolve wastes the user's time at exactly the moment they are trying to trust us.
   */
  async pair(): Promise<PairingMaterial> {
    await this.ensureUserRegistered();
    const invite = this.connectInvite();
    return {
      invite,
      uri: inviteToUri(invite),
      // A share code is the encodable form of an invite; ours is built from our own
      // canonical uuid and a full-width fingerprint, so `null` here would mean a bug in
      // this peer rather than bad input.
      shareCode: encodeShareCode(invite),
      safetyNumber: safetyNumber(this.identity.encPublicKey),
    };
  }

  /**
   * Mint the **short** server-issued pairing code for this peer.
   *
   * Offered because the endpoint exists, but it is not the path this design prefers
   * (PRD-agent-connection §7.2): the short code's fingerprint arrives from the server in
   * the same breath as the uuid it is checked against, so it is a self-consistency test
   * rather than a pin. The long share code from {@link pair} carries the fingerprint
   * out-of-band and stays the recommended route — both ends here are the user's own, so
   * there is no reason to take the weaker one.
   *
   * Registration is not best-effort here: the issue route is signed and the server
   * resolves our signing key from the published user row, so an unregistered peer gets a
   * 401 rather than a code — and a code nobody can resolve is worse than a loud failure.
   */
  async mintPairingCode(): Promise<PairingCodeIssuedDto> {
    await this.ensureUserRegistered();
    return this.api.postPairingCode({
      uuid: this.identity.uuid,
      encKeyFingerprint: fingerprintOf(this.identity.encPublicKey),
      displayName: this.config.displayName,
      kind: CONNECTION_KIND_AGENT,
    });
  }
}

/** What `pair` hands the user: the same invite in the three forms they might use. */
export interface PairingMaterial {
  readonly invite: ConnectInvite;
  /** The `loyaltycard://share` link — what the QR encodes. */
  readonly uri: string;
  /** The long hyphen-grouped code, or null if the invite could not be encoded. */
  readonly shareCode: string | null;
  /** Grouped hex digest of our encryption key, to compare against the app's screen. */
  readonly safetyNumber: string;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
