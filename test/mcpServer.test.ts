import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { TolarAgent } from '../src/agent.js';
import { cardTools } from '../src/mcp/cardTools.js';
import { SERVER_INSTRUCTIONS, SERVER_NAME, createServer, toolsFor } from '../src/mcp/server.js';
import { shoppingTools } from '../src/mcp/shoppingTools.js';
import { ToolContent, type ToolDefinition } from '../src/mcp/tool.js';

/**
 * The protocol edge: a real MCP client talking to this server over a linked pair of
 * in-memory transports.
 *
 * One property is worth this much machinery. A tool that refuses must come back as a
 * **failed tool call** carrying its message, not as a JSON-RPC error: the ownership
 * refusal ("cards belong to the account that created them") is information the model
 * has to act on, and a transport-level error would leave it with a stack trace and no
 * idea that the right next move is to add its own card instead.
 */
const tools: ToolDefinition[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns what it was given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    run: async (args) => ({ said: args.text }),
  },
  {
    name: 'picture',
    title: 'Picture',
    description: 'Returns bytes rather than a value.',
    inputSchema: { type: 'object', properties: {} },
    run: async () =>
      new ToolContent([
        { type: 'text', text: '{"bytes":1}' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ]),
  },
  {
    name: 'refuse',
    title: 'Refuse',
    description: 'Always refuses.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      throw new Error('cards belong to the account that created them');
    },
  },
];

async function connected(served: readonly ToolDefinition[] = tools) {
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    createServer(served).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('the MCP server', () => {
  it('introduces itself and states the contract before the first call', async () => {
    const client = await connected();
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain('CANNOT edit or delete a card the user created');
    // The two resources differ, and the difference is the thing a model must not have to
    // discover by being refused: cards are single-author, the shopping list is not.
    expect(SERVER_INSTRUCTIONS).toContain('editing, checking off, moving or removing the user');
    expect(SERVER_INSTRUCTIONS).toContain('That is\na refusal, not an empty result');
  });

  it('lists its tools with their schemas and hints', async () => {
    const { tools: listed } = await (await connected()).listTools();
    expect(listed.map((t) => t.name)).toEqual(['echo', 'picture', 'refuse']);
    expect(listed[0]!.annotations?.readOnlyHint).toBe(true);
    expect(listed[0]!.inputSchema).toMatchObject({ type: 'object' });
  });

  it('returns a tool result as JSON text', async () => {
    const result = await (await connected()).callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ said: 'hi' });
  });

  it('passes a tool that answers with bytes through as image content', async () => {
    // The photo tool is the only one whose answer is not JSON. A host renders an image
    // block; a summary flattened into base64 text would arrive as a wall of characters
    // no model can see and no user can look at.
    const result = await (await connected()).callTool({ name: 'picture', arguments: {} });
    expect(result.content).toEqual([
      { type: 'text', text: '{"bytes":1}' },
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    ]);
  });

  it('reports a refusal as a failed tool call carrying its reason', async () => {
    const result = await (await connected()).callTool({ name: 'refuse', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toBe(
      'cards belong to the account that created them',
    );
  });

  it('answers an unknown tool the same way, rather than dropping the connection', async () => {
    const result = await (await connected()).callTool({ name: 'nope', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain('no such tool');
  });
});

/**
 * The registry itself — what `serveStdio` actually hands a host.
 *
 * The cases above prove transport behaviour against synthetic tools, and the group tests
 * prove each group is well-formed; neither says whether `toolsFor` still includes a
 * group. That gap is quiet by construction: drop `shoppingTools(...)` from the list and
 * typecheck, lint, build and every other test stay green while nine tools become
 * unreachable over MCP. So this asserts the real registry, by name.
 */

/** Every tool `toolsFor` is expected to expose. Names, not a count: swapping one group
 * for another keeps the count and is exactly the change worth failing on. */
const EXPECTED_TOOLS = [
  'list_cards',
  'get_card',
  'get_card_photo',
  'add_card',
  'update_card',
  'delete_card',
  'list_shopping',
  'add_items',
  'rename_item',
  'set_checked',
  'set_footnote',
  'move_item',
  'create_section',
  'rename_section',
  'remove_item',
] as const;

/**
 * A stand-in for the agent. Composing the registry hands each group its service and
 * calls nothing on it, so no backend is needed here — and the throwing proxy keeps that
 * true: if composition ever starts touching a service, this fails by name instead of
 * quietly requiring a live account.
 */
function stubAgent(): TolarAgent {
  const service = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`composing the registry must not use the service: ${String(property)}`);
      },
    },
  );
  return { cards: service, photos: service, shopping: service } as TolarAgent;
}

describe('the tool registry', () => {
  it('exposes every card and shopping tool, by name', () => {
    expect(toolsFor(stubAgent()).map((t) => t.name)).toEqual([...EXPECTED_TOOLS]);
  });

  it('leaves no group behind — the expected set is every group, whole', () => {
    // Keeps the list above honest. Dropping a group from toolsFor and editing
    // EXPECTED_TOOLS to match would pass the case above; it fails here.
    const agent = stubAgent();
    const grouped = [...cardTools(agent.cards, agent.photos), ...shoppingTools(agent.shopping)].map(
      (t) => t.name,
    );
    expect([...EXPECTED_TOOLS].sort()).toEqual([...grouped].sort());
  });

  it('serves that registry over a session, schemas and all', async () => {
    const { tools: listed } = await (await connected(toolsFor(stubAgent()))).listTools();
    expect(listed.map((t) => t.name)).toEqual([...EXPECTED_TOOLS]);
    for (const tool of listed) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' });
    }
  });
});
