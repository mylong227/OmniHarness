import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { Transport } from '../../src/server/transport/lineTransport.ts';
import { McpStatelessClient } from '../../src/mcp/mcpStatelessClient.ts';

class FakeTransport implements Transport {
  public readonly sent: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.sent.push(message);
    const request = message as { id?: number; method?: string };
    if (request.method === 'server/discover') {
      this.reply(request.id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'v2', version: '1' },
      });
    } else if (request.method === 'tools/list') {
      this.reply(request.id, {
        tools: [
          { name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {} } },
        ],
      });
    } else if (request.method === 'tools/call') {
      this.reply(request.id, { content: [{ type: 'text', text: 'ok' }], isError: false });
    }
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  private reply(id: number | undefined, result: unknown): void {
    setImmediate(() => {
      this.callback?.({ jsonrpc: '2.0', id: id ?? 0, result } as RpcMessage);
    });
  }
}

test('INT-02：MCP 2026-07-28 无状态客户端用 server/discover + _meta', async () => {
  const transport = new FakeTransport();
  const client = new McpStatelessClient({ transport, timeoutMs: 1000 });
  const info = await client.initialize();
  assert.strictEqual(info.protocolVersion, '2026-07-28');
  const tools = await client.listTools();
  assert.strictEqual(tools[0]?.name, 'echo');
  const result = await client.callTool('echo', { text: 'hi' });
  assert.strictEqual(result.isError, false);
  assert.strictEqual(result.content[0]?.type, 'text');
  const first = transport.sent[0] as { params?: { _meta?: Record<string, unknown> } };
  assert.strictEqual(
    first.params?._meta?.['io.modelcontextprotocol/protocolVersion'],
    '2026-07-28',
  );
  client.close();
});
