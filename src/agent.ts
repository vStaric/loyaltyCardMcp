import { CardService } from './cards/cardService.js';
import { ShoppingService } from './shopping/shoppingService.js';
import type { PeerConfig } from './config.js';
import { TolarPeer } from './peer.js';
import { ConnectionManager } from './sharing/connections.js';
import { RosterStore } from './sharing/rosterStore.js';

/**
 * The assembled agent: the peer core, the roster, and the services built on both.
 *
 * One place where the wiring lives, because two callers need the same graph — the MCP
 * server that exposes the tools, and the CLI that pairs, accepts and revokes. Building
 * it twice is how the two would end up with different rosters or a second version
 * store, and the failure that follows (a `ver` the server has already seen) would show
 * up as a mysterious 409 far from its cause.
 */
export interface TolarAgent {
  readonly peer: TolarPeer;
  readonly roster: RosterStore;
  readonly cards: CardService;
  readonly shopping: ShoppingService;
  readonly connections: ConnectionManager;
}

/**
 * Open (or, on first run, mint) this agent's identity and build everything on top.
 *
 * The re-publish that follows a roster change fans out over `republishers`: accepting a
 * connection has to re-wrap **every** resource this agent shares, not just the one the
 * caller happened to be thinking about, so each new resource adds itself to that list
 * rather than to a call site somewhere.
 */
export async function openAgent(
  overrides: Partial<PeerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TolarAgent> {
  const peer = await TolarPeer.open(overrides, env);
  const roster = new RosterStore(peer.config.configDir);
  const cards = new CardService(peer.identity, peer.api, peer.crypto, peer.state, roster, {
    ensureRegistered: () => peer.ensureUserRegistered(),
  });
  const shopping = new ShoppingService(peer.identity, peer.api, peer.crypto, peer.state, roster, {
    ensureRegistered: () => peer.ensureUserRegistered(),
  });
  const republishers: (() => Promise<unknown>)[] = [
    () => cards.republish(),
    () => shopping.republish(),
  ];
  const connections = new ConnectionManager(
    peer.identity,
    peer.api,
    peer.crypto,
    peer.state,
    roster,
    async () => {
      for (const republish of republishers) await republish();
    },
  );
  return { peer, roster, cards, shopping, connections };
}
