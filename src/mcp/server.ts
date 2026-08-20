import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { TolarAgent } from '../agent.js';
import { cardTools } from './cardTools.js';
import { argsOf, type ToolDefinition } from './tool.js';

/**
 * The MCP surface: this agent's Tolar account, exposed to a model as tools.
 *
 * ## What is deliberately not here
 * Nothing that changes **who** this agent shares with. Pairing, accepting an inbound
 * request and revoking a connection are CLI commands run by the person who set the
 * agent up, because `requestShare` is a permissionless route — a tool that could accept
 * a connection would let anyone who learns this agent's uuid talk it into sharing.
 * The model gets to use the grant; only the operator gets to make one.
 */
export const SERVER_NAME = 'tolar-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Instructions handed to the host at initialize — the short version of the contract
 * these tools live under, so a model reads it before its first call rather than
 * discovering it in an error.
 */
export const SERVER_INSTRUCTIONS = `Tolar: a shared loyalty-card and shopping-list account, reached as an ordinary connection.

This agent has its own account. It is a peer, exactly like a person the user shared with,
with the same powers and the same limits:

- It can read every card an account has shared with it.
- It can add cards. They land in this agent's own list and appear in the user's grid
  attributed to this agent — deduplicated by barcode, like any peer's card.
- It can edit and delete the cards IT added.
- It CANNOT edit or delete a card the user created. That is not a policy this server
  applies; a card is a single blob signed by its author, and the server would reject the
  write. A human peer cannot edit the user's cards either.

If a connection has not granted this agent its cards, tools say so by name. That is a
refusal, not an empty list — do not report it to the user as "you have no cards".`;

/**
 * The tools `agent` exposes. Split out from the transport so tests can drive them
 * directly — what matters about this surface is what it refuses and how it says so,
 * and that must not be reachable only through a stdio session.
 */
export function toolsFor(agent: TolarAgent): readonly ToolDefinition[] {
  return cardTools(agent.cards);
}

/**
 * An MCP server exposing `tools`.
 *
 * A tool that throws is reported as a **failed tool call** — `isError` with the
 * message — rather than a protocol error, so the model sees why it was refused and can
 * act on it. That distinction is the whole design of the ownership refusal: "cards
 * belong to the account that created them" is information the caller needs, and a
 * transport-level error would strip it to a stack trace.
 */
export function createServer(tools: readonly ToolDefinition[]): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return errorResult(`no such tool: ${request.params.name}`);
    }
    try {
      const result = await tool.run(argsOf(request.params.arguments));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  return server;
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * Serve over stdio — the transport an MCP host launches this process on.
 *
 * **stdout belongs to the protocol.** Anything this process prints there is framed as a
 * JSON-RPC message and corrupts the session, so every diagnostic goes to stderr. The
 * CLI's other commands print to stdout freely; this one must not.
 */
export async function serveStdio(agent: TolarAgent): Promise<Server> {
  const server = createServer(toolsFor(agent));
  await server.connect(new StdioServerTransport());
  return server;
}
