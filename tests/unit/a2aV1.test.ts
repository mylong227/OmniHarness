import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { A2aTransport } from '../../src/a2a/a2aProtocol.ts';
import { A2aServer, type TaskHandler } from '../../src/a2a/a2aServer.ts';

class MemoryTransport implements A2aTransport {
  public peer: MemoryTransport | undefined;
  public readonly received: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.peer?.deliver(message);
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  public deliver(message: RpcMessage): void {
    this.received.push(message);
    this.callback?.(message);
  }
}

function pair(): { client: MemoryTransport; server: MemoryTransport } {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

const handler: TaskHandler = {
  async handle(req) {
    return { ok: true, output: `v1:${req.task}`, steps: 1, durationMs: 1 };
  },
};

test('INT-03：A2A v1.0 message/send 返回 completed Task + artifacts', async () => {
  const { client, server } = pair();
  const a2a = new A2aServer(server);
  a2a.setTaskHandler(handler);
  const response = new Promise<RpcMessage>((resolve) => {
    client.onMessage((message) => resolve(message));
  });
  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: { messageId: 'm1', parts: [{ type: 'text', text: 'hello' }] },
    },
  } as RpcMessage);
  const result = (await response) as {
    result?: { status?: { state?: string }; artifacts?: { parts?: { text?: string }[] }[] };
  };
  assert.strictEqual(result.result?.status?.state, 'completed');
  assert.strictEqual(result.result?.artifacts?.[0]?.parts?.[0]?.text, 'v1:hello');
});

test('INT-03：A2A v1.0 agent/getCard 返回配置的 AgentCard', async () => {
  const { client, server } = pair();
  const a2a = new A2aServer(server);
  a2a.setAgentCard({ name: 'omni', description: 'test', version: '1.0.0' });
  const response = new Promise<RpcMessage>((resolve) => {
    client.onMessage((message) => resolve(message));
  });
  client.send({ jsonrpc: '2.0', id: 2, method: 'agent/getCard', params: {} } as RpcMessage);
  const result = (await response) as { result?: { name?: string } };
  assert.strictEqual(result.result?.name, 'omni');
});
