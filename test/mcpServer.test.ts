import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS, SERVER_NAME, createServer } from '../src/mcp/server.js';
import type { ToolDefinition } from '../src/mcp/tool.js';

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
    name: 'refuse',
    title: 'Refuse',
    description: 'Always refuses.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      throw new Error('cards belong to the account that created them');
    },
  },
];

async function connected() {
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    createServer(tools).connect(serverTransport),
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
    expect(SERVER_INSTRUCTIONS).toContain('That is a\nrefusal, not an empty list');
  });

  it('lists its tools with their schemas and hints', async () => {
    const { tools: listed } = await (await connected()).listTools();
    expect(listed.map((t) => t.name)).toEqual(['echo', 'refuse']);
    expect(listed[0]!.annotations?.readOnlyHint).toBe(true);
    expect(listed[0]!.inputSchema).toMatchObject({ type: 'object' });
  });

  it('returns a tool result as JSON text', async () => {
    const result = await (await connected()).callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ said: 'hi' });
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
