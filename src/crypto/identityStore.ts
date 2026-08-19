import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { generateMnemonic, isValidMnemonic, mnemonicToSeed } from './bip39.js';
import { identityFromSeed, type Identity } from './identity.js';
import type { SodiumCrypto } from './sodium.js';

const IDENTITY_FILE = 'identity.json';
const FILE_FORMAT = 1;

/**
 * Persists this peer's sync identity and exposes the working {@link Identity}. The
 * counterpart of the app's `crypto/IdentityStore.kt`, with one honest difference
 * stated up front.
 *
 * ## Storage model
 * The only secret stored is the BIP-39 **mnemonic**. From it the seed, every key and
 * the UUID are re-derived, so the words are a complete backup and losing them with the
 * host means the remote data is unrecoverable — the accepted no-account tradeoff
 * (PRD-sync-sharing §8).
 *
 * ## What is different here, and why it is not hidden
 * The app seals its entropy with a hardware-backed Android Keystore key. **There is no
 * equivalent on a laptop or a hosted box**, so this file is protected by nothing but
 * file permissions (`0600` in a `0700` directory) and whatever full-disk encryption the
 * host has. Anyone who can read the file is this agent.
 *
 * That is a real reduction in protection relative to the phone, and it is the reason
 * the agent holds its *own* identity rather than the user's (PRD-agent-connection
 * §3.2): the blast radius of this file is "what the user shared with the agent", and
 * the user can revoke it from the app in one action. It would be a very different
 * document if these bytes were the user's seed.
 */
export class IdentityStore {
  private cached: Identity | null = null;

  constructor(
    private readonly configDir: string,
    private readonly sodium: SodiumCrypto,
  ) {}

  /** True once an identity has been generated or imported on this host. */
  exists(): boolean {
    try {
      statSync(this.file());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The working identity, loaded (and cached for the process) from the stored
   * mnemonic. Generates a brand-new identity on first ever call.
   */
  getOrCreate(): Identity {
    if (this.cached) return this.cached;
    const mnemonic = this.exists() ? this.readMnemonic() : this.write(generateMnemonic());
    this.cached = this.identityFromMnemonic(mnemonic);
    return this.cached;
  }

  /**
   * The account uuid **if this host already has an identity**, else null — for callers
   * that want to know who they are without becoming somebody. {@link getOrCreate} mints
   * a brand-new identity when none exists, which is right for a deliberate `pair` and
   * wrong for a status read.
   */
  uuidIfPresent(): string | null {
    return this.exists() ? this.getOrCreate().uuid : null;
  }

  /**
   * Adopt an existing recovery phrase, replacing whatever this host held. Rejects a
   * mnemonic that fails its BIP-39 checksum rather than deriving a plausible-looking
   * identity from a typo — a wrong phrase mints a *different account* that silently
   * shares nothing.
   */
  importMnemonic(mnemonic: string): Identity {
    if (!isValidMnemonic(mnemonic)) {
      throw new Error('not a valid BIP-39 recovery phrase (word list or checksum)');
    }
    const stored = this.write(mnemonic);
    this.cached = this.identityFromMnemonic(stored);
    return this.cached;
  }

  /**
   * The recovery phrase for this identity — the portable backup. Generates one if the
   * host has no identity yet, so `export` after `pair` is never a surprise failure.
   */
  exportMnemonic(): string {
    if (!this.exists()) this.getOrCreate();
    return this.readMnemonic();
  }

  /**
   * Forget this identity. Returns false when there was nothing to erase.
   *
   * The account it named still exists on the server with everything it published; use
   * `TolarApi.deleteUser` first if the intent is to erase the account rather than this
   * host's copy of its key.
   */
  erase(): boolean {
    const existed = this.exists();
    rmSync(this.file(), { force: true });
    this.cached = null;
    return existed;
  }

  private identityFromMnemonic(mnemonic: string): Identity {
    return identityFromSeed(mnemonicToSeed(mnemonic), this.sodium);
  }

  private readMnemonic(): string {
    const path = this.file();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new Error(`identity file is unreadable: ${path}`, { cause: e });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`identity file is not an object: ${path}`);
    }
    const record = parsed as Record<string, unknown>;
    if (record.format !== FILE_FORMAT) {
      throw new Error(
        `identity file format ${String(record.format)} is not supported (expected ${FILE_FORMAT}): ${path}`,
      );
    }
    const mnemonic = record.mnemonic;
    if (typeof mnemonic !== 'string' || !isValidMnemonic(mnemonic)) {
      // Refusing beats deriving: a corrupted phrase would mint a different account and
      // then fail every share with a confusing "no wrapped key for recipient".
      throw new Error(`identity file does not hold a valid recovery phrase: ${path}`);
    }
    return mnemonic;
  }

  /** Write the mnemonic owner-only, atomically, and return it. */
  private write(mnemonic: string): string {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode is masked by the umask and skipped entirely if the directory
    // already existed, so tighten it explicitly.
    chmodSync(this.configDir, 0o700);
    const path = this.file();
    const temp = `${path}.tmp`;
    const body = `${JSON.stringify({ format: FILE_FORMAT, mnemonic }, null, 2)}\n`;
    // Write-then-rename so a crash mid-write cannot leave a half-written phrase where a
    // whole one used to be. `mode` is set at create time so the secret is never briefly
    // world-readable.
    writeFileSync(temp, body, { mode: 0o600, flag: 'w' });
    renameSync(temp, path);
    return mnemonic;
  }

  private file(): string {
    return join(this.configDir, IDENTITY_FILE);
  }
}
