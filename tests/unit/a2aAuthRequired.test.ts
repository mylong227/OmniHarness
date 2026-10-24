/**
 * A2A 1.0 任务内认证判据（`auth_required`，规范 §7.6）。
 *
 * 覆盖：executor 要求认证 → 任务落 `auth_required`（challenge 进 status.message / 任务 metadata）；
 * `tasks/get` 可查；无凭据续跑 fail-closed（不改状态、不执行、绝不判完成）；
 * `message.metadata.assertion` 与传输注入的 `Authorization` 两条凭据通道都能续跑；
 * 凭据被拒时仍留在 `auth_required` 并更新 challenge；对非认证任务续跑返回 -32004。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type {
  A2aAuthChallenge,
  A2aTask,
  A2aTransport,
  DelegateRequest,
  DelegateResult,
} from '../../src/a2a/a2aProtocol.ts';
import { A2aServer, type TaskHandler } from '../../src/a2a/a2aServer.ts';

/** 双端内存传输。 */
class MemoryTransport implements A2aTransport {
  public peer: MemoryTransport | undefined;
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.peer?.deliver(message);
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }
}

/** 已接线的 JSON-RPC 调用端（按 id 关联响应）。 */
interface RpcHarness {
  /** 交给 A2aServer 的服务端侧传输。 */
  readonly serverTransport: MemoryTransport;
  /** 发一条请求并等待同一 id 的响应。 */
  readonly call: (method: string, params: unknown) => Promise<RpcMessage>;
}

/** 建立一对内存传输并返回可按响应兑现的调用端。 */
function harness(): RpcHarness {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  let nextId = 1;
  const pending = new Map<number, (message: RpcMessage) => void>();
  client.onMessage((message) => {
    if (!('id' in message) || typeof message.id !== 'number') return;
    pending.get(message.id)?.(message);
  });
  return {
    serverTransport: server,
    call: (method: string, params: unknown): Promise<RpcMessage> => {
      const id = nextId++;
      return new Promise<RpcMessage>((resolve) => {
        pending.set(id, resolve);
        client.send({ jsonrpc: '2.0', id, method, params } as RpcMessage);
      });
    },
  };
}

/** 认证门控处理器：凭据为 `good-token` 才完成，否则要求认证（用于测拒绝后仍留在 auth_required）。 */
class AuthGatedHandler implements TaskHandler {
  public calls = 0;
  public readonly assertions: (string | undefined)[] = [];
  public async handle(request: DelegateRequest): Promise<DelegateResult> {
    this.calls += 1;
    this.assertions.push(request.assertion);
    if (request.assertion === 'good-token') {
      return { ok: true, output: `done:${request.task}`, steps: 1, durationMs: 1 };
    }
    return {
      ok: false,
      output: '',
      steps: 0,
      durationMs: 0,
      authRequired: AuthGatedHandler.challengeFor(request.assertion, this.calls),
    };
  }
  /** 构造 challenge（凭据缺失 → Bearer；凭据被拒 → 换 OAuth2 并说明原因）。 */
  private static challengeFor(assertion: string | undefined, attempt: number): A2aAuthChallenge {
    return {
      scheme: assertion === undefined ? 'Bearer' : 'OAuth2',
      description:
        assertion === undefined ? '需要 Bearer 令牌才能继续' : 'Bearer 令牌无效，请改用 OAuth2',
      url: 'https://auth.example.test/token',
      scopes: ['tasks:write'],
      metadata: { attempt },
    };
  }
}

/** 取响应里的任务载荷（断言形状）。 */
function taskOf(message: RpcMessage): A2aTask {
  const result = (message as { readonly result?: A2aTask }).result;
  assert.ok(result !== undefined, `响应缺少 result: ${JSON.stringify(message)}`);
  return result;
}

/** 取响应里的 JSON-RPC 错误码。 */
function errorCodeOf(message: RpcMessage): number | undefined {
  return (message as { readonly error?: { readonly code?: number } }).error?.code;
}

/** 首条消息（新建任务）。 */
function firstMessage(text: string, messageId: string): unknown {
  return { message: { messageId, parts: [{ type: 'text', text }] } };
}

/** 续跑消息（以 `message.taskId` 指回目标任务；凭据可放 metadata 或 params）。 */
function resumeMessage(taskId: string, text: string, metadata?: Record<string, unknown>): unknown {
  return {
    message: {
      messageId: `${taskId}-resume`,
      taskId,
      parts: [{ type: 'text', text }],
      ...(metadata !== undefined ? { metadata } : {}),
    },
  };
}

test('AUTH ①：executor 要求认证 → 任务落 auth_required，challenge 同时进 status.message 与任务 metadata', async () => {
  const rpc = harness();
  const handler = new AuthGatedHandler();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler(handler);
  const response = taskOf(await rpc.call('message/send', firstMessage('需要授权的操作', 'm-auth')));
  assert.strictEqual(response.status.state, 'auth_required');
  assert.strictEqual(handler.calls, 1);
  const message = response.status.message;
  assert.ok(message !== undefined, 'auth_required 必须带 status.message（规范 §7.6.1-3）');
  const challenge = (message.metadata as { readonly authChallenge?: A2aAuthChallenge } | undefined)
    ?.authChallenge;
  assert.strictEqual(challenge?.scheme, 'Bearer');
  assert.deepStrictEqual(challenge?.scopes, ['tasks:write']);
  assert.strictEqual(challenge?.url, 'https://auth.example.test/token');
  const taskChallenge = (
    response.metadata as { readonly authChallenge?: A2aAuthChallenge } | undefined
  )?.authChallenge;
  assert.strictEqual(taskChallenge?.scheme, 'Bearer');
  assert.match(
    message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    /需要认证/u,
  );
  assert.strictEqual(response.artifacts, undefined, '认证未完成时不得产出 artifact');
});

test('AUTH ②：tasks/get 可查询 auth_required 任务（标准查询面不被阻断）', async () => {
  const rpc = harness();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler(new AuthGatedHandler());
  await rpc.call('message/send', firstMessage('查我', 'm-get-auth'));
  const got = taskOf(await rpc.call('tasks/get', { id: 'm-get-auth' }));
  assert.strictEqual(got.status.state, 'auth_required');
  assert.strictEqual(
    (got.metadata as { readonly authChallenge?: A2aAuthChallenge }).authChallenge?.scheme,
    'Bearer',
  );
});

test('AUTH ③：无凭据续跑 fail-closed —— 不执行、不改状态、绝不假装完成', async () => {
  const rpc = harness();
  const handler = new AuthGatedHandler();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler(handler);
  await rpc.call('message/send', firstMessage('等待凭据', 'm-no-cred'));
  const resumed = taskOf(
    await rpc.call('message/send', resumeMessage('m-no-cred', '我再想想，先不给凭据')),
  );
  assert.strictEqual(resumed.status.state, 'auth_required');
  assert.strictEqual(handler.calls, 1, '无凭据不得再次调用 executor');
  assert.strictEqual(resumed.artifacts, undefined);
  const got = taskOf(await rpc.call('tasks/get', { id: 'm-no-cred' }));
  assert.strictEqual(got.status.state, 'auth_required');
});

test('AUTH ④：metadata.assertion 提供凭据后续跑成功并清掉 challenge', async () => {
  const rpc = harness();
  const handler = new AuthGatedHandler();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler(handler);
  await rpc.call('message/send', firstMessage('给凭据', 'm-cred'));
  const resumed = taskOf(
    await rpc.call(
      'message/send',
      resumeMessage('m-cred', '这是凭据', { assertion: 'good-token' }),
    ),
  );
  assert.strictEqual(resumed.status.state, 'completed');
  assert.strictEqual(handler.calls, 2);
  assert.deepStrictEqual(handler.assertions, [undefined, 'good-token']);
  assert.strictEqual(
    resumed.artifacts?.[0]?.parts[0]?.type === 'text' ? resumed.artifacts[0].parts[0].text : '',
    'done:这是凭据',
  );
  assert.strictEqual(
    (resumed.metadata as { readonly authChallenge?: unknown } | undefined)?.authChallenge,
    undefined,
    '认证满足后不得残留旧 challenge',
  );
});

test('AUTH ⑤：传输注入的 params.assertion（HTTP Authorization 原文）同样可续跑', async () => {
  const rpc = harness();
  const handler = new AuthGatedHandler();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler(handler);
  await rpc.call('message/send', firstMessage('header 凭据', 'm-header'));
  const resumed = taskOf(
    await rpc.call('message/send', {
      ...(resumeMessage('m-header', 'header 里带了令牌') as Record<string, unknown>),
      assertion: 'good-token',
    }),
  );
  assert.strictEqual(resumed.status.state, 'completed');
  assert.strictEqual(handler.assertions[1], 'good-token');
});

test('AUTH ⑥：凭据被拒仍留在 auth_required，并带上新的 challenge（不判失败也不判完成）', async () => {
  const rpc = harness();
  const handler = new AuthGatedHandler();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler(handler);
  await rpc.call('message/send', firstMessage('错误凭据', 'm-bad-cred'));
  const rejected = taskOf(
    await rpc.call(
      'message/send',
      resumeMessage('m-bad-cred', '用错令牌', { assertion: 'bad-token' }),
    ),
  );
  assert.strictEqual(rejected.status.state, 'auth_required');
  const challenge = (rejected.metadata as { readonly authChallenge?: A2aAuthChallenge } | undefined)
    ?.authChallenge;
  assert.strictEqual(challenge?.scheme, 'OAuth2', '拒绝后应换新 challenge 而不是完成');
  assert.match(challenge?.description ?? '', /无效/u);
  assert.strictEqual(rejected.status.message?.metadata !== undefined, true);
});

test('AUTH ⑦：对非 auth_required 任务用 message.taskId 续跑返回 -32004', async () => {
  const rpc = harness();
  const server = new A2aServer(rpc.serverTransport);
  server.setTaskHandler({
    async handle(request: DelegateRequest): Promise<DelegateResult> {
      return { ok: true, output: `echo:${request.task}`, steps: 1, durationMs: 1 };
    },
  });
  const completed = taskOf(await rpc.call('message/send', firstMessage('已完成任务', 'm-done')));
  assert.strictEqual(completed.status.state, 'completed');
  const denied = await rpc.call('message/send', resumeMessage('m-done', '试图续跑'));
  assert.strictEqual(errorCodeOf(denied), -32004);
  assert.match(
    (denied as { readonly error?: { readonly message?: string } }).error?.message ?? '',
    /auth_required/u,
  );
  // 未知任务 id 仍按 TaskNotFound（-32001）报，不与「不可续跑」混淆。
  const missing = await rpc.call('message/send', resumeMessage('m-missing', '不存在的任务'));
  assert.strictEqual(errorCodeOf(missing), -32001);
});
