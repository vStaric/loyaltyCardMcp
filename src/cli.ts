#!/usr/bin/env node
import { toString as qrToString } from 'qrcode';
import { openAgent } from './agent.js';
import { defaultConfigDir, type PeerConfig } from './config.js';
import { IdentityStore } from './crypto/identityStore.js';
import { initSodium } from './crypto/sodium.js';
import { serveStdio } from './mcp/server.js';
import { TolarPeer } from './peer.js';
import type { PeerDiscovery } from './sharing/connections.js';
import type { Connection, Eviction } from './sharing/roster.js';

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
  tolar-mcp accept <request-id> [--kind agent|person]
  tolar-mcp decline <request-id> [--api-url URL] [--config-dir DIR]
  tolar-mcp leave [--api-url URL] [--config-dir DIR]
  tolar-mcp status [--config-dir DIR]
  tolar-mcp export-phrase [--config-dir DIR]
  tolar-mcp import-phrase "<twelve words …>" [--config-dir DIR]

Commands:
  serve           Run the MCP server on stdio — what an MCP host launches.
  pair            Publish this agent's user row and print the invite for the app to scan.
  connections     Show who this agent shares with, refresh peers of peers, and list any
                  request waiting for an answer.
  accept          Accept an inbound share request, after comparing its safety number.
                  Accepting is admission to the household: they are sealed every
                  resource this agent publishes. There is no narrower answer.
  decline         Refuse an inbound share request: hide it here, and record the refusal.
  leave           Take this agent out of every household it is in, and tell them. It
                  cannot take anyone else out of one — that is a member's to do, in the
                  app. Takes no account: there is no "remove them", only "we leave".
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
    case 'decline':
      return decline(overrides, positional[0]);
    case 'leave':
      return leave(overrides, positional[0]);
    // Named so it fails with the reason rather than as an unknown command, because an
    // operator typing it is not making a typo — they are reaching for a capability that
    // was deliberately removed, and "unknown command" would read as a broken install
    // (lcm-9m7).
    case 'revoke':
      process.stderr.write(
        'revoke is gone. This agent cannot remove an account from a household: members\n' +
          'may kick a person or an agent out, and this agent is not one of the parties\n' +
          'that may.\n\n' +
          'To remove somebody, do it in the app, on a member’s device.\n' +
          'To take THIS agent out, run `tolar-mcp leave` — which leaves every household\n' +
          'it is in, and needs nobody’s permission.\n',
      );
      return 1;
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
  // Learn the peers of this agent's peers before the first tool call, so a write in
  // this session is sealed to the whole space rather than to whoever ran the connect
  // flow (lcm-8lm). Best-effort and reported on stderr: an unreachable server is a
  // reason to serve a smaller roster, never a reason not to serve.
  const discovery = await agent.connections.syncPeers().catch((e: unknown) => e as Error);
  if (discovery instanceof Error) {
    process.stderr.write(`could not check for peers of peers: ${discovery.message}\n`);
  } else {
    reportDiscovery(discovery, (line) => process.stderr.write(line));
  }
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
  // Refresh before listing. An operator running this command is asking who this agent
  // shares with *now*, and an indirect peer that has joined the space since the last
  // run is precisely the entry they most need to be shown.
  const discovery = await agent.connections.syncPeers().catch((e: unknown) => e as Error);
  const current = agent.connections.connections();
  process.stdout.write(`Account:  ${agent.peer.identity.uuid}\n\n`);
  // Before the roster, because it is the answer to a different question than "who is in
  // the list": an agent a household showed the door is not connected to it, and printing
  // an empty roster without saying why would read as "nobody ever connected" (lcm-9m7).
  const evictedSelf = agent.connections.evictedSelf();
  if (evictedSelf) {
    process.stdout.write(
      `A member of a household this agent was in declared this agent out, on\n` +
        `${new Date(evictedSelf.at).toISOString()}. It was told by ${evictedSelf.learnedFrom}.\n` +
        'This agent has left that household: it publishes nothing to it and seals nothing\n' +
        'to its members. Getting back in means a fresh invitation from a member, accepted\n' +
        'here with `tolar-mcp accept`.\n\n',
    );
  }
  if (current.length === 0) {
    process.stdout.write('Connected to nobody yet.\n');
  } else {
    const names = new Map(current.map((c) => [c.uuid, c.displayName ?? c.uuid]));
    process.stdout.write('Connected:\n');
    for (const c of current) {
      process.stdout.write(
        `  ${c.displayName ?? '(unnamed)'}  ${c.uuid}${indirectTag(c, names)}\n` +
          `    labelled: ${c.kind}\n`,
      );
    }
    // Said once, for the household, rather than per entry: there is no per-account
    // grant to print any more, and a column that showed the same value on every row
    // would read as a control an operator could change. This one cannot be narrowed.
    process.stdout.write(
      '\n  Everyone listed is a member of this household, and this agent seals every\n' +
        '  resource it publishes to all of them — every card, every shopping list, barcode\n' +
        '  values included. Membership is the whole grant; there is no per-account setting\n' +
        '  here and nothing to narrow.\n',
    );
    if (current.some((c) => c.learnedFrom !== null)) {
      process.stdout.write(
        '\n  Entries marked "indirect" are accounts you did not accept yourself. They were\n' +
          '  named in the grant document of the connection they are attributed to, which was\n' +
          "  verified against that connection's pinned key before anything was added, and\n" +
          '  this agent seals its writes to them on exactly the terms above — an account\n' +
          '  you did not personally approve reads the barcode values too.\n' +
          '  A member of the household can remove any of them; this agent cannot.\n',
      );
    }
  }
  reportEvictions(agent.connections.evictions(), agent.peer.identity.uuid, (line) =>
    process.stdout.write(line),
  );
  if (discovery instanceof Error) {
    process.stderr.write(
      `\nCould not check for peers of peers: ${discovery.message}\n` +
        "The list above is this agent's last known roster, which may be missing accounts.\n",
    );
  } else {
    reportDiscovery(discovery, (line) => process.stdout.write(line));
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
      '\nAccept with:  tolar-mcp accept <id>\n' +
      'Decline with: tolar-mcp decline <id>   (hides it here, and tells them)\n',
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
  if (flags.has('scopes')) {
    // Refused rather than ignored. An operator typing `--scopes shopping` is asking for
    // a narrowing this agent can no longer perform, and accepting the request anyway
    // would hand over the cards they just said to withhold.
    process.stderr.write(
      '--scopes is gone: household membership implies every scope, so accepting shares\n' +
        'every card and every shopping list with them, barcode values included. Re-run\n' +
        'without the flag if that is what you mean to do.\n',
    );
    return 1;
  }
  const agent = await openAgent(overrides);
  const kindFlag = flags.get('kind');
  const connection = await agent.connections.accept(id, {
    ...(kindFlag === 'person' || kindFlag === 'agent' ? { kind: kindFlag } : {}),
  });
  process.stdout.write(
    `Connected: ${connection.displayName ?? connection.uuid}\n` +
      'They are a member of this household now, so this agent seals every resource it\n' +
      'publishes to them — cards and shopping lists alike, barcode values included.\n' +
      '\nWhat THEY share with this agent is their decision, made on their accept screen.\n' +
      'If their cards do not reach this agent, the card tools will say so by name rather\n' +
      'than reporting an empty list.\n',
  );
  return 0;
}

/**
 * Decline an inbound share request — the answer the inbox had no way to give.
 *
 * Two things happen, and the output separates them because only one can fail: the
 * request stops being offered here (local, certain), and the refusal is recorded where
 * the requester can read it (a PUT, best-effort). Silence is not a decline — an invite
 * we never answer sits at "waiting" in their app on purpose — so a decision that did
 * not reach the server is reported as exactly that rather than as a delivered "no".
 */
async function decline(
  overrides: Partial<PeerConfig>,
  requestId: string | undefined,
): Promise<number> {
  const id = Number(requestId);
  if (!Number.isSafeInteger(id)) {
    process.stderr.write('decline needs the request id from `tolar-mcp connections`\n');
    return 1;
  }
  const agent = await openAgent(overrides);
  const { request, notified } = await agent.connections.decline(id);
  const who = request.displayName ?? request.requesterUuid;
  process.stdout.write(
    `Declined [${request.id}] ${who}\n` +
      'This agent shares nothing with them, and the request stops appearing here.\n',
  );
  if (notified === 'sent') {
    process.stdout.write('Their app will show this invite as declined rather than unanswered.\n');
    return 0;
  }
  if (notified === 'skipped') {
    process.stdout.write(
      'This request had already been actioned here, so nothing new was recorded for\n' +
        'them — what their app shows is unchanged.\n',
    );
    return 0;
  }
  process.stderr.write(
    '\nCould not record the refusal for them, so their app still shows this invite as\n' +
      'unanswered. That is a true statement about what they know, and nothing here is\n' +
      'shared with them either way. Re-running `decline` will not retry it.\n',
  );
  return 1;
}

/**
 * Take this agent out of every household — the operator's off switch (lcm-9m7).
 *
 * The output's job is to make the direction unmistakable. `revoke <uuid>` read as "make
 * them go away" and in fact did; this reads as "we go away" and in fact does, and the
 * refusal below is what an operator reaching for the old verb meets instead of a
 * connection quietly disappearing from somebody else's roster.
 */
async function leave(overrides: Partial<PeerConfig>, target: string | undefined): Promise<number> {
  if (target !== undefined) {
    process.stderr.write(
      'leave takes no account: it takes THIS agent out, not somebody else.\n\n' +
        'There is no command here that removes another member from a household — members\n' +
        'may kick a person or an agent out, and this agent is not one of the parties that\n' +
        'may. Do that in the app, on a member’s device.\n\n' +
        'Run `tolar-mcp leave` with no argument to walk this agent out of every household\n' +
        'it is in.\n',
    );
    return 1;
  }
  const agent = await openAgent(overrides);
  const { left, notified } = await agent.connections.leave();
  if (left.length === 0) {
    process.stdout.write('This agent is in no household — nothing to leave.\n');
    return 0;
  }
  process.stdout.write(
    `Left. This agent shares with nobody now, and its next publish rotates its content\n` +
      `key away from all ${left.length} account(s) it was sealing to:\n`,
  );
  for (const c of left) {
    process.stdout.write(`  ${c.displayName ?? '(unnamed)'}  ${c.uuid}\n`);
  }
  if (notified === 'sent') {
    process.stdout.write(
      '\nThey were told: this agent published a final grant document saying it is out, so\n' +
        'their app can drop it rather than keep a member that has gone quiet.\n',
    );
  } else {
    process.stderr.write(
      '\nCould not tell them, so their app still lists this agent as a member. That changes\n' +
        'nothing about what is shared — this agent seals to nobody as of now — but somebody\n' +
        'will have to remove it there by hand. Re-running `leave` will not retry it.\n',
    );
  }
  process.stdout.write(
    '\nWhat this does not do: anything anyone already fetched, they keep. Leaving is not\n' +
      'retroactive and nothing here can make it so. For what this agent read, that reaches\n' +
      'further than it would for a person — the plaintext went to a model provider.\n',
  );
  return notified === 'failed' ? 1 : 0;
}

/**
 * List the evictions this agent is honouring (lcm-9m7), or print nothing.
 *
 * An account that used to be in the roster and now is not is exactly the kind of change
 * an operator will otherwise assume is a bug in the discovery pass. Naming who declared
 * them out, and when, is what turns "the list got shorter" into a fact about the
 * household. The one naming this agent is printed at the top of the command instead.
 */
function reportEvictions(
  evictions: readonly Eviction[],
  selfUuid: string,
  write: (line: string) => void,
): void {
  const others = evictions.filter((e) => e.uuid !== selfUuid);
  if (others.length === 0) return;
  write('\nDeclared out of the household, so this agent no longer seals to them:\n');
  for (const e of others) {
    write(
      `  ${e.uuid}\n    by ${e.by} at ${new Date(e.at).toISOString()}, read from ${e.learnedFrom}\n`,
    );
  }
  write(
    '\n  This agent obeys these; it cannot issue one and cannot undo one. A member who\n' +
      '  invites the account back is what brings it back — and the invitation has to be\n' +
      '  dated later than the eviction, on clocks this agent does not control.\n',
  );
}

/** `  (indirect, via Vid)` for a peer learned from a grant document, else nothing. */
function indirectTag(connection: Connection, names: Map<string, string>): string {
  const via = connection.learnedFrom;
  if (via === null) return '';
  return `  (indirect, via ${names.get(via) ?? via})`;
}

/**
 * Say what a discovery pass did, when it did anything worth saying.
 *
 * A silent pass is the normal case and prints nothing. The two that are not silent are
 * a peer refused for a reason the operator can act on, and a connection whose grant
 * document could not be read at all — because a roster that is quietly short is
 * indistinguishable from a space with nobody else in it.
 */
function reportDiscovery(discovery: PeerDiscovery, write: (line: string) => void): void {
  if (discovery.added.length > 0) {
    write(`\nAdded ${discovery.added.length} account(s) learned from a connection's grant doc.\n`);
  }
  // Never silent, on either surface. A pass that obeyed an eviction changed who this
  // agent seals to on somebody else's say-so, which is the one change an operator is
  // most entitled to hear about at the moment it happens (lcm-9m7).
  for (const e of discovery.evicted) {
    write(`\nHonoured an eviction: ${e.by} declared ${e.uuid} out, read from ${e.learnedFrom}.\n`);
  }
  const refused = discovery.skipped.filter(
    (s) => s.reason !== 'self' && s.reason !== 'already_known',
  );
  for (const s of refused) {
    write(`\nNot added: ${s.displayName ?? s.uuid} (${s.reason})\n  ${s.detail}\n`);
  }
  for (const source of discovery.unreadable) {
    if (source.reason === 'not_published' || source.reason === 'not_granted') continue;
    write(
      `\nCould not read who ${source.displayName ?? source.uuid} shares with ` +
        `(${source.reason})\n  ${source.detail}\n`,
    );
  }
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
