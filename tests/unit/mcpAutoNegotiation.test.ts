/** MCP 自动协商：v2 发现失败必须回退 legacy（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { RpcMessage } from '../../src/ports/server/rpcMessage.ts';
import type { Transport } from '../../src/ports/server/transport.ts';
import type { McpServerConfig } from '../../src/ports/mcp/mcpServerConfig.ts';
import { mcpConnector } from '../../src/mcp/mcpConnector.ts';
import { mcpStdioTransport } from '../../src/mcp/mcpStdioTransport.ts';

class FallbackTransport implements Transport {
  public readonly methods: string[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;

  public send(message: RpcMessage): void {
    const request = message as { id?: number; method?: string };
    this.methods.push(request.method ?? '');
    if (request.method === 'server/discover') {
      setImmediate(() => {
        this.callback?.({
          jsonrpc: '2.0',
          id: request.id ?? 0,
          error: { code: -32601, message: 'Method not found' },
        } as RpcMessage);
      });
    } else if (request.method === 'initialize') {
      setImmediate(() => {
        this.callback?.({
          jsonrpc: '2.0',
          id: request.id ?? 0,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'legacy', version: '1' },
          },
        } as RpcMessage);
      });
    }
  }

  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
}

test('INT-01：auto 先试 server/discover，失败后在同一 transport 上走 legacy initialize', async () => {
  const transport = new FallbackTransport();
  const original = mcpStdioTransport.launch;
  mcpStdioTransport.launch = () =>
    ({
      transport,
      process: {} as ChildProcess,
      failure: new Promise<never>(() => undefined),
      close: () => undefined,
    }) as ReturnType<typeof original>;
  const server: McpServerConfig = { name: 'legacy-server', command: 'node' };
  try {
    const connection = await mcpConnector.connect(server, 500);
    assert.strictEqual(connection.info.protocolVersion, '2025-06-18');
    assert.deepStrictEqual(transport.methods.slice(0, 2), ['server/discover', 'initialize']);
    connection.close();
  } finally {
    mcpStdioTransport.launch = original;
  }
});
