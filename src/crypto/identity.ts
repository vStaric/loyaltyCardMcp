import { deriveIdentitySecrets } from './identityDeriver.js';
import type { SodiumCrypto, SodiumKeyPair } from './sodium.js';

/**
 * This agent's cryptographic sync identity, fully derived from its BIP-39 seed —
 * the port of `crypto/Identity.kt`.
 *
 * Two independent keypairs are used — Ed25519 for signing and X25519 for key
 * agreement — because reusing one keypair across signing and encryption is an
 * anti-pattern (PRD-sync-sharing §4, §10.1).
 *
 * The agent derives its **own** seed. It is never handed the user's
 * (PRD-agent-connection §3.2): borrowing the user's identity would make every agent
 * write indistinguishable from a user write, leave nothing to revoke, and widen the
 * blast radius from "what the user shared with the agent" to "everything ever shared
 * with the user".
 */
export interface Identity {
  /** The account UUID — the public `user/{uuid}` resource locator. */
  readonly uuid: string;
  /** Ed25519 keypair (32-byte public, 64-byte secret) used to sign envelopes and requests. */
  readonly signingKeyPair: SodiumKeyPair;
  /** X25519 keypair (32-byte public/secret) used to unwrap content keys sealed to us. */
  readonly encryptionKeyPair: SodiumKeyPair;
  /** Raw Ed25519 public key — published at `user/{uuid}.sign_key`. */
  readonly signPublicKey: Uint8Array;
  /** Raw X25519 public key — published at `user/{uuid}.enc_key`, used to wrap CEKs to us. */
  readonly encPublicKey: Uint8Array;
}

/**
 * Derive an {@link Identity} from a 64-byte BIP-39 `seed` using `sodium` for the
 * keypair generation. Deterministic: the same seed always yields the same UUID and
 * keys, which is what makes the recovery phrase a complete backup.
 */
export function identityFromSeed(seed: Uint8Array, sodium: SodiumCrypto): Identity {
  const secrets = deriveIdentitySecrets(seed);
  const signingKeyPair = sodium.ed25519KeyPairFromSeed(secrets.ed25519Seed);
  const encryptionKeyPair = sodium.x25519KeyPairFromSeed(secrets.x25519Seed);
  return {
    uuid: secrets.uuid,
    signingKeyPair,
    encryptionKeyPair,
    signPublicKey: signingKeyPair.publicKey,
    encPublicKey: encryptionKeyPair.publicKey,
  };
}
