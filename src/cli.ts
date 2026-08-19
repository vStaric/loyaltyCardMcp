#!/usr/bin/env node
import { toString as qrToString } from 'qrcode';
import { defaultConfigDir, type PeerConfig } from './config.js';
import { IdentityStore } from './crypto/identityStore.js';
import { initSodium } from './crypto/sodium.js';
import { TolarPeer } from './peer.js';

/**
 * The operator-facing commands for the peer core. The MCP tool surface is a separate
 * bead; what has to exist *now* is the pairing flow, because an agent nobody has
 * accepted has nothing to expose.
 */
const USAGE = `tolar-mcp — Tolar peer core

Usage:
  tolar-mcp pair [--api-url URL] [--name NAME] [--config-dir DIR] [--no-qr]
  tolar-mcp status [--config-dir DIR]
  tolar-mcp export-phrase [--config-dir DIR]
  tolar-mcp import-phrase "<twelve words …>" [--config-dir DIR]

Commands:
  pair            Publish this agent's user row and print the invite for the app to scan.
  status          Show this agent's account uuid and where its config lives.
  export-phrase   Print the BIP-39 recovery phrase — the complete backup of this identity.
  import-phrase   Adopt an existing recovery phrase, replacing this host's identity.

Environment:
  TOLAR_API_URL     Base URL of the Tolar REST API (required for pair).
  TOLAR_AGENT_NAME  Name offered in the invite (default "AI agent").
  TOLAR_MCP_HOME    Config directory (default $XDG_CONFIG_HOME/tolar-mcp).
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const { flags, positional } = parseArgs(rest);
  const overrides = configOverrides(flags);

  switch (command) {
    case 'pair':
      return pair(overrides, flags.has('no-qr'));
    case 'status':
      return status(overrides.configDir ?? defaultConfigDir());
    case 'export-phrase':
      return exportPhrase(overrides.configDir ?? defaultConfigDir());
    case 'import-phrase':
      return importPhrase(overrides.configDir ?? defaultConfigDir(), positional.join(' '));
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

async function pair(overrides: Partial<PeerConfig>, noQr: boolean): Promise<number> {
  const peer = await TolarPeer.open(overrides);
  const material = await peer.pair();

  if (!noQr) {
    process.stdout.write(`${await qrToString(material.uri, { type: 'terminal', small: true })}\n`);
  }
  process.stdout.write(`Account:  ${material.invite.uuid}\n`);
  process.stdout.write(`Name:     ${material.invite.displayName ?? '(none)'}\n`);
  process.stdout.write(`Link:     ${material.uri}\n`);
  if (material.shareCode) process.stdout.write(`Code:     ${material.shareCode}\n`);
  process.stdout.write(`Safety:   ${material.safetyNumber}\n`);
  process.stdout.write(
    '\nScan the QR in the app, or paste the code. Check the safety number against\n' +
      'the one the app shows before accepting — that comparison is what stops a\n' +
      'substituted key, and nothing else in this flow does it for you.\n' +
      '\nThe app will ask what this connection is. It is an AI agent, and the invite\n' +
      'says so — but that claim is self-declared and unverified, so the answer that\n' +
      'gets recorded is the one you give on that screen.\n',
  );
  return 0;
}

async function status(configDir: string): Promise<number> {
  const store = new IdentityStore(configDir, await initSodium());
  const uuid = store.uuidIfPresent();
  process.stdout.write(`Config:   ${configDir}\n`);
  process.stdout.write(`Account:  ${uuid ?? '(none yet — run `tolar-mcp pair`)'}\n`);
  return 0;
}

async function exportPhrase(configDir: string): Promise<number> {
  const store = new IdentityStore(configDir, await initSodium());
  if (!store.exists()) {
    process.stderr.write('no identity on this host yet — run `tolar-mcp pair` first\n');
    return 1;
  }
  process.stdout.write(`${store.exportMnemonic()}\n`);
  return 0;
}

async function importPhrase(configDir: string, mnemonic: string): Promise<number> {
  if (!mnemonic.trim()) {
    process.stderr.write('import-phrase needs the recovery phrase as its argument\n');
    return 1;
  }
  const store = new IdentityStore(configDir, await initSodium());
  const identity = store.importMnemonic(mnemonic);
  process.stdout.write(`Account:  ${identity.uuid}\n`);
  return 0;
}

function configOverrides(flags: Map<string, string | true>): Partial<PeerConfig> {
  const overrides: { -readonly [K in keyof PeerConfig]?: PeerConfig[K] } = {};
  const apiUrl = flags.get('api-url');
  const name = flags.get('name');
  const configDir = flags.get('config-dir');
  if (typeof apiUrl === 'string') overrides.baseUrl = apiUrl;
  if (typeof name === 'string') overrides.displayName = name;
  if (typeof configDir === 'string') overrides.configDir = configDir;
  return overrides;
}

/** `--flag value`, `--flag=value` and bare `--flag`; everything else is positional. */
function parseArgs(argv: string[]): {
  flags: Map<string, string | true>;
  positional: string[];
} {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { flags, positional };
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
