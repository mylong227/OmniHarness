import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { A2aTransport } from '../../src/a2a/a2aProtocol.ts';
import { A2aServer, type TaskHandler } from '../../src/a2a/a2aServer.ts';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.ts';

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

test('INT-03：A2A v1.0 配置身份后 message/send 必须验签（2026-10-21）', async () => {
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'v1-auth' });
  const unsigned = pair();
  const serverUnsigned = new A2aServer(unsigned.server, identity);
  serverUnsigned.setTaskHandler(handler);
  const unsignedResponse = new Promise<RpcMessage>((resolve) => {
    unsigned.client.onMessage((message) => resolve(message));
  });
  unsigned.client.send({
    jsonrpc: '2.0',
    id: 10,
    method: 'message/send',
    params: { message: { messageId: 'm10', parts: [{ type: 'text', text: 'hello' }] } },
  } as RpcMessage);
  const denied = (await unsignedResponse) as { error?: { message?: string } };
  assert.match(denied.error?.message ?? '', /UNAUTHORIZED/u, '无签名必须被拒');

  const signed = pair();
  const serverSigned = new A2aServer(signed.server, identity);
  serverSigned.setTaskHandler(handler);
  const signedResponse = new Promise<RpcMessage>((resolve) => {
    signed.client.onMessage((message) => resolve(message));
  });
  signed.client.send({
    jsonrpc: '2.0',
    id: 11,
    method: 'message/send',
    params: {
      message: { messageId: 'm11', parts: [{ type: 'text', text: 'hello' }] },
      assertion: identity.signAssertion('m11'),
    },
  } as RpcMessage);
  const ok = (await signedResponse) as { result?: { status?: { state?: string } } };
  assert.strictEqual(ok.result?.status?.state, 'completed', '有效签名必须放行');
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

test('INT-03：A2A 幂等——同 messageId 重发不重建任务、不重跑 handler（2026-10-28）', async () => {
  const { client, server } = pair();
  let runs = 0;
  const counting: TaskHandler = {
    async handle(req) {
      runs += 1;
      return { ok: true, output: `v1:${req.task}`, steps: 1, durationMs: 1 };
    },
  };
  const a2a = new A2aServer(server);
  a2a.setTaskHandler(counting);
  const received: RpcMessage[] = [];
  client.onMessage((message) => received.push(message));
  const waitFor = async (n: number): Promise<void> => {
    for (let i = 0; i < 200 && received.length < n; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const message = { messageId: 'm-idem', parts: [{ type: 'text' as const, text: 'hello' }] };
  client.send({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message } } as RpcMessage);
  await waitFor(1);
  client.send({ jsonrpc: '2.0', id: 2, method: 'message/send', params: { message } } as RpcMessage);
  await waitFor(2);

  const results = received.map(
    (entry) => (entry as { result?: { id?: string; status?: { state?: string } } }).result ?? {},
  );
  assert.strictEqual(runs, 1, '同一 messageId 只能执行一次');
  assert.strictEqual(results[0]?.id, results[1]?.id, '两次返回必须是同一个任务');
  assert.strictEqual(results[1]?.status?.state, 'completed');
});
