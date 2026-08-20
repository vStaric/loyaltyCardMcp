#!/usr/bin/env node
import { toString as qrToString } from 'qrcode';
import { openAgent } from './agent.js';
import { defaultConfigDir, type PeerConfig } from './config.js';
import { IdentityStore } from './crypto/identityStore.js';
import { initSodium } from './crypto/sodium.js';
import { serveStdio } from './mcp/server.js';
import { TolarPeer } from './peer.js';
import { RESOURCE_SCOPES, type ResourceScope } from './sharing/roster.js';

/**
 * The operator-facing commands.
 *
 * Everything that decides **who this agent shares with** lives here and nowhere else:
 * `requestShare` is a permissionless route, so accepting one is a decision for the
 * person who set the agent up, not for the model it serves (see `mcp/server.ts`).
 */
const USAGE = `tolar-mcp — Tolar MCP server

Usage:
  tolar-mcp serve [--api-url URL] [--config-dir DIR]
  tolar-mcp pair [--api-url URL] [--name NAME] [--config-dir DIR] [--no-qr]
  tolar-mcp connections [--api-url URL] [--config-dir DIR]
  tolar-mcp accept <request-id> [--scopes cards,shopping] [--kind agent|person]
  tolar-mcp revoke <uuid> [--api-url URL] [--config-dir DIR]
  tolar-mcp status [--config-dir DIR]
  tolar-mcp export-phrase [--config-dir DIR]
  tolar-mcp import-phrase "<twelve words …>" [--config-dir DIR]

Commands:
  serve           Run the MCP server on stdio — what an MCP host launches.
  pair            Publish this agent's user row and print the invite for the app to scan.
  connections     Show who this agent shares with, and any request waiting for an answer.
  accept          Accept an inbound share request, after comparing its safety number.
  revoke          Stop sharing with an account and rotate this agent's keys away from it.
  status          Show this agent's account uuid and where its config lives.
  export-phrase   Print the BIP-39 recovery phrase — the complete backup of this identity.
  import-phrase   Adopt an existing recovery phrase, replacing this host's identity.

Environment:
  TOLAR_API_URL     Base URL of the Tolar REST API (required for everything but status).
  TOLAR_AGENT_NAME  Name offered in the invite (default "AI agent").
  TOLAR_MCP_HOME    Config directory (default $XDG_CONFIG_HOME/tolar-mcp).
  TOLAR_MCP_MAX_PHOTO_BYTES
                    Largest card photo get_card_photo will return (default 2 MiB, the
                    backend's own per-blob ceiling).
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
    case 'serve':
      return serve(overrides);
    case 'pair':
      return pair(overrides, flags.has('no-qr'));
    case 'connections':
      return connections(overrides);
    case 'accept':
      return accept(overrides, positional[0], flags);
    case 'revoke':
      return revoke(overrides, positional[0]);
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

/**
 * Run the MCP server on stdio.
 *
 * Nothing is written to stdout here, ever: the host frames that stream as JSON-RPC and
 * a stray line of ours would corrupt the session. The banner goes to stderr, which is
 * where a host shows server logs.
 */
async function serve(overrides: Partial<PeerConfig>): Promise<number> {
  const agent = await openAgent(overrides);
  await serveStdio(agent);
  const count = agent.roster.load().connections.length;
  process.stderr.write(
    `tolar-mcp serving on stdio as ${agent.peer.identity.uuid} ` +
      `(${count} connection${count === 1 ? '' : 's'})\n`,
  );
  if (count === 0) {
    process.stderr.write(
      'No connections yet: the card tools can only report that nobody has shared ' +
        'anything with this agent. Run `tolar-mcp pair`, accept the invite in the app, ' +
        'then `tolar-mcp accept <id>` here.\n',
    );
  }
  // Resolving would let the process exit out from under the transport; the server runs
  // until stdin closes, which is how the host stops it.
  return new Promise<number>(() => {});
}

/** Who this agent shares with, and who is asking. */
async function connections(overrides: Partial<PeerConfig>): Promise<number> {
  const agent = await openAgent(overrides);
  const current = agent.connections.connections();
  process.stdout.write(`Account:  ${agent.peer.identity.uuid}\n\n`);
  if (current.length === 0) {
    process.stdout.write('Connected to nobody yet.\n');
  } else {
    process.stdout.write('Connected:\n');
    for (const c of current) {
      const scopes = c.scopes.length > 0 ? c.scopes.join(', ') : 'nothing';
      process.stdout.write(
        `  ${c.displayName ?? '(unnamed)'}  ${c.uuid}\n` +
          `    this agent shares: ${scopes}   labelled: ${c.kind}\n`,
      );
    }
  }

  // The roster above is local and always printable; the inbox needs the network. A
  // failure there must not read as "nobody is asking" — that is exactly the moment an
  // operator would walk away from a request that is in fact waiting.
  let pending;
  try {
    pending = await agent.connections.pending();
  } catch (e) {
    process.stderr.write(
      `\nCould not reach the server to check for requests: ${(e as Error).message}\n` +
        'This says nothing about whether any are waiting.\n',
    );
    return 1;
  }
  if (pending.length === 0) {
    process.stdout.write('\nNo requests waiting.\n');
    return 0;
  }
  process.stdout.write('\nWaiting for an answer:\n');
  for (const r of pending) {
    process.stdout.write(
      `  [${r.id}] ${r.displayName ?? '(unnamed)'}  ${r.requesterUuid}\n` +
        `    asked at: ${r.createdAt}   says it is: ${r.declaredKind}\n` +
        `    safety:   ${r.safetyNumber}\n`,
    );
  }
  process.stdout.write(
    '\nCompare the safety number against the one the app shows for this account before\n' +
      'accepting. Everything else about a request reached us through the server, so that\n' +
      'comparison is the only step that would catch a substituted key.\n' +
      '\nAccept with: tolar-mcp accept <id>\n',
  );
  return 0;
}

/** Accept an inbound share request — the one place this agent starts sharing. */
async function accept(
  overrides: Partial<PeerConfig>,
  requestId: string | undefined,
  flags: Map<string, string | true>,
): Promise<number> {
  const id = Number(requestId);
  if (!Number.isSafeInteger(id)) {
    process.stderr.write('accept needs the request id from `tolar-mcp connections`\n');
    return 1;
  }
  const agent = await openAgent(overrides);
  const scopes = parseScopes(flags.get('scopes'));
  const kindFlag = flags.get('kind');
  const connection = await agent.connections.accept(id, {
    ...(scopes ? { scopes } : {}),
    ...(kindFlag === 'person' || kindFlag === 'agent' ? { kind: kindFlag } : {}),
  });
  process.stdout.write(
    `Connected: ${connection.displayName ?? connection.uuid}\n` +
      `This agent now shares its ${connection.scopes.join(' and ') || 'nothing'} with them.\n` +
      '\nWhat THEY share with this agent is their decision, made on their accept screen.\n' +
      'If they withheld the cards, the card tools will say so by name rather than\n' +
      'reporting an empty list.\n',
  );
  return 0;
}

/** Stop sharing with an account, and say plainly what that does not undo. */
async function revoke(overrides: Partial<PeerConfig>, uuid: string | undefined): Promise<number> {
  if (!uuid) {
    process.stderr.write('revoke needs the account uuid from `tolar-mcp connections`\n');
    return 1;
  }
  const agent = await openAgent(overrides);
  if (!(await agent.connections.revoke(uuid))) {
    process.stderr.write(`not connected to ${uuid}\n`);
    return 1;
  }
  process.stdout.write(
    `Revoked ${uuid}. This agent's next publish rotates its content key away from them.\n` +
      '\nWhat this does not do: anything they already fetched, they keep. Revoking is not\n' +
      'retroactive and nothing here can make it so.\n',
  );
  return 0;
}

/** `--scopes cards,shopping` — what this agent shares, or undefined for the default. */
function parseScopes(raw: string | true | undefined): readonly ResourceScope[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  const scopes = names.filter((n): n is ResourceScope =>
    (RESOURCE_SCOPES as readonly string[]).includes(n),
  );
  const unknown = names.filter((n) => !(RESOURCE_SCOPES as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scope(s): ${unknown.join(', ')} (known: ${RESOURCE_SCOPES.join(', ')})`,
    );
  }
  // An explicit empty list is a real answer — "connected, sharing nothing" — so it is
  // kept rather than folded back into the default.
  return scopes;
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
