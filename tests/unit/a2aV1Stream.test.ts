/**
 * A2A v1.0 协议判据（规范：https://a2a-protocol.org/v1.0.0/specification）。
 *
 * 覆盖：message/stream（SSE 语义 / 事件顺序）、tasks/cancel、tasks/subscribe、
 * push notification config（create/get/list/delete + 真实 HTTP webhook）、
 * AgentCard / 认证扩展卡、legacy 私有委托面，以及真实 HTTP SSE 传输。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import { A2aServer, type TaskHandler } from '../../src/a2a/a2aServer.ts';
import { HttpA2aServerTransport } from '../../src/a2a/httpA2aTransport.ts';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.ts';
import type {
  A2aTask,
  A2aTransport,
  DelegateRequest,
  DelegateResult,
} from '../../src/a2a/a2aProtocol.ts';

/** 双端内存传输。 */
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

/** 带闸门与取消能力的处理器（用于流式/取消/订阅用例）。 */
class GatedHandler implements TaskHandler {
  public cancelCalls = 0;
  public constructor(private readonly gate: Promise<void>) {}
  public async handle(request: DelegateRequest): Promise<DelegateResult> {
    await this.gate;
    return { ok: true, output: `out:${request.task}`, steps: 1, durationMs: 1 };
  }
  public cancel(): boolean {
    this.cancelCalls += 1;
    return true;
  }
}

/** 立即返回的处理器。 */
const echoHandler: TaskHandler = {
  async handle(request: DelegateRequest): Promise<DelegateResult> {
    return { ok: true, output: `echo:${request.task}`, steps: 1, durationMs: 1 };
  },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor<T>(
  items: () => readonly T[],
  predicate: (item: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = items().find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

/** 取某 id 的全部响应。 */
function responsesOf(transport: MemoryTransport, id: number): RpcMessage[] {
  return transport.received.filter((message) => 'id' in message && message.id === id);
}

/** 发送一条 JSON-RPC 请求（从 client 端）。 */
function call(client: MemoryTransport, id: number, method: string, params: unknown): void {
  client.send({ jsonrpc: '2.0', id, method, params } as RpcMessage);
}

test('1) message/stream：Task → working → artifact → completed(final) 顺序正确', async () => {
  const gate = deferred();
  const { client, server } = pair();
  const a2a = new A2aServer(server);
  a2a.setTaskHandler(new GatedHandler(gate.promise));
  call(client, 1, 'message/stream', {
    message: { messageId: 'm-stream', parts: [{ type: 'text', text: 'hi' }] },
    contextId: 'ctx-1',
  });
  // 首帧任务快照
  const first = await waitFor(
    () => responsesOf(client, 1),
    (message) => 'result' in message,
  );
  const firstResult = (first as { readonly result?: { readonly task?: A2aTask } }).result;
  assert.strictEqual(firstResult?.task?.status.state, 'submitted');
  assert.strictEqual(firstResult?.task?.id, 'm-stream');
  gate.resolve();
  const final = await waitFor(
    () => responsesOf(client, 1),
    (message) => {
      const result = (
        message as { readonly result?: { readonly statusUpdate?: { readonly final?: boolean } } }
      ).result;
      return result?.statusUpdate?.final === true;
    },
  );
  const events = responsesOf(client, 1).map(
    (message) => (message as { readonly result?: Record<string, unknown> }).result,
  );
  assert.deepStrictEqual(
    events.map((event) => {
      if (event === undefined) return 'none';
      if ('task' in event) return 'task';
      if ('artifactUpdate' in event) return 'artifact';
      return 'status';
    }),
    ['task', 'status', 'artifact', 'status'],
  );
  const finalStatus = (
    final as {
      readonly result?: { readonly statusUpdate?: { readonly status?: A2aTask['status'] } };
    }
  ).result?.statusUpdate?.status;
  assert.strictEqual(finalStatus?.state, 'completed');
});

test('2) tasks/cancel：后台任务被取消并落 canceled；重复取消返回 TaskNotCancelable', async () => {
  const gate = deferred();
  const handler = new GatedHandler(gate.promise);
  const { client, server } = pair();
  const a2a = new A2aServer(server);
  a2a.setTaskHandler(handler);
  call(client, 1, 'message/send', {
    message: { messageId: 'm-cancel', parts: [{ type: 'text', text: 'long' }] },
    configuration: { returnImmediately: true },
  });
  const submitted = await waitFor(
    () => responsesOf(client, 1),
    (message) => 'result' in message,
  );
  const task = (submitted as { readonly result?: A2aTask }).result;
  assert.strictEqual(task?.status.state, 'submitted');
  call(client, 2, 'tasks/cancel', { id: 'm-cancel' });
  const canceled = await waitFor(
    () => responsesOf(client, 2),
    (message) => 'result' in message,
  );
  assert.strictEqual((canceled as { readonly result?: A2aTask }).result?.status.state, 'canceled');
  assert.strictEqual(handler.cancelCalls, 1);
  gate.resolve();
  call(client, 3, 'tasks/cancel', { id: 'm-cancel' });
  const denied = await waitFor(
    () => responsesOf(client, 3),
    (message) => 'error' in message,
  );
  assert.strictEqual(
    (denied as { readonly error?: { readonly code?: number } }).error?.code,
    -32002,
  );
});

test('3) tasks/subscribe：先回当前 Task 快照，随后收到完成事件并收尾', async () => {
  const gate = deferred();
  const { client, server } = pair();
  const a2a = new A2aServer(server);
  a2a.setTaskHandler(new GatedHandler(gate.promise));
  call(client, 1, 'message/stream', {
    message: { messageId: 'm-sub', parts: [{ type: 'text', text: 'watch' }] },
  });
  await waitFor(
    () => responsesOf(client, 1),
    (message) => 'result' in message,
  );
  call(client, 2, 'tasks/subscribe', { taskId: 'm-sub' });
  const snapshot = await waitFor(
    () => responsesOf(client, 2),
    (message) => 'result' in message,
  );
  assert.strictEqual(
    (snapshot as { readonly result?: { readonly task?: A2aTask } }).result?.task?.id,
    'm-sub',
  );
  gate.resolve();
  const final = await waitFor(
    () => responsesOf(client, 2),
    (message) => {
      const result = (
        message as { readonly result?: { readonly statusUpdate?: { readonly final?: boolean } } }
      ).result;
      return result?.statusUpdate?.final === true;
    },
  );
  const status = (
    final as {
      readonly result?: { readonly statusUpdate?: { readonly status?: A2aTask['status'] } };
    }
  ).result?.statusUpdate?.status;
  assert.strictEqual(status?.state, 'completed');
});

test('4) push notification：内联配置 → webhook POST（含 token 头）→ get/list/delete', async () => {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const webhook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204);
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    webhook.listen(0, '127.0.0.1', () => {
      const address = webhook.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  try {
    const gate = deferred();
    const { client, server } = pair();
    const a2a = new A2aServer(server);
    a2a.setTaskHandler(new GatedHandler(gate.promise));
    const url = `http://127.0.0.1:${String(port)}/hook`;
    call(client, 1, 'message/send', {
      message: { messageId: 'm-push', parts: [{ type: 'text', text: 'notify' }] },
      configuration: {
        returnImmediately: true,
        pushNotificationConfig: { url, token: 'tok-1' },
      },
    });
    await waitFor(
      () => responsesOf(client, 1),
      (message) => 'result' in message,
    );
    call(client, 2, 'tasks/pushNotificationConfig/list', { taskId: 'm-push' });
    const listed = await waitFor(
      () => responsesOf(client, 2),
      (message) => 'result' in message,
    );
    const configs = (listed as { readonly result?: { readonly configs?: { id?: string }[] } })
      .result?.configs;
    assert.strictEqual(configs?.length, 1);
    const configId = configs?.[0]?.id;
    assert.ok(configId);
    gate.resolve();
    const notification = await waitFor(
      () => received,
      (item) => item.body.includes('"state":"completed"'),
    );
    assert.match(notification.body, /statusUpdate/u);
    assert.match(notification.body, /completed/u);
    assert.strictEqual(notification.headers['x-a2a-notification-token'], 'tok-1');
    call(client, 3, 'tasks/pushNotificationConfig/get', {
      taskId: 'm-push',
      pushNotificationConfigId: configId,
    });
    const got = await waitFor(
      () => responsesOf(client, 3),
      (message) => 'result' in message,
    );
    assert.strictEqual(
      (got as { readonly result?: { readonly pushNotificationConfig?: { id?: string } } }).result
        ?.pushNotificationConfig?.id,
      configId,
    );
    call(client, 4, 'tasks/pushNotificationConfig/delete', {
      taskId: 'm-push',
      pushNotificationConfigId: configId,
    });
    const deleted = await waitFor(
      () => responsesOf(client, 4),
      (message) => 'result' in message,
    );
    assert.strictEqual(
      (deleted as { readonly result?: { readonly deleted?: boolean } }).result?.deleted,
      true,
    );
    call(client, 5, 'tasks/pushNotificationConfig/delete', {
      taskId: 'm-push',
      pushNotificationConfigId: configId,
    });
    const again = await waitFor(
      () => responsesOf(client, 5),
      (message) => 'result' in message,
    );
    assert.strictEqual(
      (again as { readonly result?: { readonly deleted?: boolean } }).result?.deleted,
      false,
    );
  } finally {
    webhook.close();
  }
});

test('5) AgentCard + 认证扩展卡：公开卡可读；未签名扩展卡被拒、有效签名放行', async () => {
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'card-agent' });
  const { client, server } = pair();
  const a2a = new A2aServer(server, identity);
  a2a.setAgentCard({
    name: 'omniharness',
    description: 'test',
    version: '0.2.0',
    protocolVersion: '1.0',
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true },
    securitySchemes: { agentAssertion: { type: 'apiKey', in: 'header', name: 'Authorization' } },
    security: [{ agentAssertion: [] }],
  });
  call(client, 1, 'agent/getCard', {});
  const card = await waitFor(
    () => responsesOf(client, 1),
    (message) => 'result' in message,
  );
  const cardResult = (card as { readonly result?: { readonly protocolVersion?: string } }).result;
  assert.strictEqual(cardResult?.protocolVersion, '1.0');
  call(client, 2, 'agent/getAuthenticatedExtendedCard', {});
  const denied = await waitFor(
    () => responsesOf(client, 2),
    (message) => 'error' in message,
  );
  assert.strictEqual(
    (denied as { readonly error?: { readonly code?: number } }).error?.code,
    -32000,
  );
  call(client, 3, 'agent/getAuthenticatedExtendedCard', {
    assertion: identity.authorizationHeader('card-agent'),
  });
  const allowed = await waitFor(
    () => responsesOf(client, 3),
    (message) => 'result' in message,
  );
  assert.strictEqual(
    (allowed as { readonly result?: { readonly capabilities?: { extendedAgentCard?: boolean } } })
      .result?.capabilities?.extendedAgentCard,
    true,
  );
});

test('6) legacy 兼容：capabilities.declare / task.delegate / message/send / tasks/get 全部可用', async () => {
  const { client, server } = pair();
  const a2a = new A2aServer(server);
  a2a.setTaskHandler(echoHandler);
  call(client, 1, 'capabilities.declare', {
    agentId: 'peer-1',
    capabilities: [{ name: 'code-review' }],
  });
  const accepted = await waitFor(
    () => responsesOf(client, 1),
    (message) => 'result' in message,
  );
  assert.deepStrictEqual((accepted as { readonly result?: unknown }).result, { accepted: true });
  assert.strictEqual(a2a.getDeclaration('peer-1')?.capabilities[0]?.name, 'code-review');
  call(client, 2, 'task.delegate', { taskId: 'd-1', task: 'legacy' });
  const delegated = await waitFor(
    () => responsesOf(client, 2),
    (message) => 'result' in message,
  );
  assert.strictEqual(
    (delegated as { readonly result?: DelegateResult }).result?.output,
    'echo:legacy',
  );
  call(client, 3, 'message/send', {
    message: { messageId: 'm-legacy', parts: [{ type: 'text', text: 'v1' }] },
  });
  const sent = await waitFor(
    () => responsesOf(client, 3),
    (message) => 'result' in message,
  );
  assert.strictEqual((sent as { readonly result?: A2aTask }).result?.status.state, 'completed');
  call(client, 4, 'tasks/get', { id: 'm-legacy' });
  const got = await waitFor(
    () => responsesOf(client, 4),
    (message) => 'result' in message,
  );
  assert.strictEqual((got as { readonly result?: A2aTask }).result?.status.state, 'completed');
});

test('7) 真实 HTTP 传输：message/stream 返回 text/event-stream 且末条 final:true', async () => {
  const transport = new HttpA2aServerTransport();
  const a2a = new A2aServer(transport);
  a2a.setTaskHandler(echoHandler);
  const port = await transport.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: {
          message: { messageId: 'm-http', parts: [{ type: 'text', text: 'sse' }] },
        },
      }),
    });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
    const text = await response.text();
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map(
        (line) =>
          JSON.parse(line.slice('data: '.length)) as { readonly result?: Record<string, unknown> },
      );
    assert.ok(events.length >= 3, `SSE 事件过少：${String(events.length)}`);
    const last = events.at(-1)?.result as
      { readonly statusUpdate?: { readonly final?: boolean } } | undefined;
    assert.strictEqual(last?.statusUpdate?.final, true);
    assert.match(JSON.stringify(events.at(-1)), /completed/u);
  } finally {
    transport.close();
  }
});
