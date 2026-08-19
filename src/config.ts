import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where this peer keeps its own state, and how it reaches the Tolar backend.
 *
 * The agent's seed is *its own* (PRD-agent-connection §3.2), so it needs a home of its
 * own too: one directory, owner-only, that a `--config-dir` flag or `TOLAR_MCP_HOME`
 * can move for a hosted deployment.
 */
export interface PeerConfig {
  /** Directory holding the identity file and version bookkeeping. */
  readonly configDir: string;
  /** Base URL of the Tolar REST API. */
  readonly baseUrl: string;
  /** Name this peer offers in its invite — cosmetic, carried out-of-band in the link. */
  readonly displayName: string | null;
}

/** The default when nothing overrides it: an obvious, honest name for an agent peer. */
export const DEFAULT_DISPLAY_NAME = 'AI agent';

export const ENV_CONFIG_DIR = 'TOLAR_MCP_HOME';
export const ENV_BASE_URL = 'TOLAR_API_URL';
export const ENV_DISPLAY_NAME = 'TOLAR_AGENT_NAME';

/**
 * Resolve the config directory: `TOLAR_MCP_HOME`, else `$XDG_CONFIG_HOME/tolar-mcp`,
 * else `~/.config/tolar-mcp`.
 */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[ENV_CONFIG_DIR]?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, 'tolar-mcp') : join(homedir(), '.config', 'tolar-mcp');
}

/**
 * Read the peer config from the environment, with `overrides` (CLI flags) winning.
 *
 * There is no default base URL. A wrong-but-plausible one would publish this peer's
 * user row — its identity — to whatever host happened to be baked in, so the failure
 * for "not configured" has to be loud.
 */
export function loadConfig(
  overrides: Partial<PeerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): PeerConfig {
  const baseUrl = overrides.baseUrl ?? env[ENV_BASE_URL]?.trim();
  if (!baseUrl) {
    throw new Error(`no Tolar API base URL: set ${ENV_BASE_URL} or pass --api-url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${ENV_BASE_URL} is not a valid URL: ${baseUrl}`);
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    // The envelopes are opaque to the network either way, but the per-request signature
    // headers and the account uuid are not, and a plaintext hop hands an observer the
    // map of who this peer is. Localhost is exempted so a dev backend still works.
    throw new Error(`${ENV_BASE_URL} must be https (or localhost): ${baseUrl}`);
  }
  const displayName =
    overrides.displayName !== undefined
      ? overrides.displayName
      : env[ENV_DISPLAY_NAME]?.trim() || DEFAULT_DISPLAY_NAME;
  return {
    configDir: overrides.configDir ?? defaultConfigDir(env),
    baseUrl,
    displayName: displayName || null,
  };
}
