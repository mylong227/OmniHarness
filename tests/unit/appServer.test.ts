import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServer } from '../../src/server/appServer.js';
import { type RpcMessage } from '../../src/server/jsonRpc.js';
import type { Transport } from '../../src/server/lineTransport.js';
import { ConfigFactory } from '../../src/config/omniharnessConfig.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

/** 可编程传输（测试双端）。 */
class TestTransport implements Transport {
  readonly sent: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;

  send(message: RpcMessage): void {
    this.sent.push(message);
  }

  onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /** 模拟客户端发送请求（轮询等待响应，容忍异步 handle）。 */
  async receive(method: string, params: Record<string, unknown>, id = 1): Promise<RpcMessage> {
    await this.callback?.({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = this.sent.find((message) => 'id' in message && message.id === id);
      if (response !== undefined) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { jsonrpc: '2.0', id, result: undefined };
  }

  /** 已发送的通知。 */
  notifications(method: string): RpcMessage[] {
    return this.sent.filter((message) => 'method' in message && message.method === method);
  }
}

/** 构造 server（approvalUplink 开启则审批上行）。 */
function buildServer(approvalUplink = false): { server: AppServer; transport: TestTransport } {
  const transport = new TestTransport();
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const server = new AppServer({ config, transport, approvalUplink });
  return { server, transport };
}

test('app-server：threads.create 返回线程并持久化', async () => {
  const { transport } = buildServer();
  const response = await transport.receive('threads.create', { prompt: '建线程' });
  const result = (response as { result: { threadId: string } }).result;
  assert.ok(result.threadId.length > 0);

  const get = await transport.receive('threads.get', { threadId: result.threadId }, 2);
  const items = (get as { result: { items: unknown[] } }).result.items;
  assert.ok(items.length >= 2, '线程应包含 user + assistant 事件');
});

test('app-server：turns.run 实时推送 thread.event 通知', async () => {
  const { transport } = buildServer();
  await transport.receive('turns.run', { prompt: '跑回合' });
  const events = transport
    .notifications('thread.event')
    .map((message) => (message as unknown as { params: { event: { type: string } } }).params.event);
  const types = events.map((event) => event.type);
  assert.ok(types.includes('user'));
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('tool_result'));
  assert.ok(types.includes('assistant'));
});

test('app-server：审批上行并响应 allow 后工具执行', async () => {
  const { transport } = buildServer(true);
  const run = transport.receive('turns.run', { prompt: '审批流程' }, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const requests = transport.notifications('approval.request');
  assert.ok(requests.length >= 1, '应发出审批请求');
  const request = requests[0] as unknown as { params: { requestId: string; toolName: string } };
  assert.strictEqual(request.params.toolName, 'shell');

  await transport.receive(
    'approval.respond',
    { requestId: request.params.requestId, decision: 'allow' },
    2,
  );
  await run;

  const results = transport.notifications('thread.event').map((message) => {
    const event = (
      message as unknown as { params: { event: { type: string; payload?: { ok?: boolean } } } }
    ).params.event;
    return { type: event.type, ok: event.payload?.ok };
  });
  const toolResults = results.filter((entry) => entry.type === 'tool_result');
  assert.ok(toolResults.length >= 1);
  assert.strictEqual(toolResults[0]?.ok, true);
});

test('app-server：审批 deny 则工具被拦截', async () => {
  const { transport } = buildServer(true);
  const run = transport.receive('turns.run', { prompt: '拒绝流程' }, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const request = transport.notifications('approval.request')[0] as unknown as {
    params: { requestId: string };
  };
  await transport.receive(
    'approval.respond',
    { requestId: request.params.requestId, decision: 'deny' },
    2,
  );
  await run;

  const events = transport
    .notifications('thread.event')
    .map(
      (message) =>
        (message as unknown as { params: { event: { type: string; payload?: { ok?: boolean } } } })
          .params.event,
    );
  const toolResults = events.filter((event) => event.type === 'tool_result');
  assert.ok(toolResults.length >= 1);
  assert.strictEqual(toolResults[0]?.payload?.ok, false);
});

test('app-server：未知方法返回错误', async () => {
  const { transport } = buildServer();
  const response = await transport.receive('nope.method', {}, 99);
  const error = (response as { error: { code: number } }).error;
  assert.strictEqual(error.code, -32601);
});

test('app-server：threads.continue 沿用同一线程', async () => {
  const { transport } = buildServer();
  const created = await transport.receive('threads.create', { prompt: '第一轮' });
  const threadId = (created as { result: { threadId: string } }).result.threadId;

  const continued = await transport.receive('threads.continue', { threadId, prompt: '第二轮' }, 2);
  const result = (continued as { result: { threadId: string } }).result;
  assert.strictEqual(result.threadId, threadId);
});

// 回归测试：UI「完全访问」（approval=auto）必须绕过 SupervisorKernel 的 fail-closed 降级，
// 否则用户点「完全访问」后首个危险工具失败即翻 safe、永久封锁写类工具（2026-09-08 用户截图根因）。
test('app-server：approval=auto 时 bypassSupervisorKernel 返回 no-op supervisor', async () => {
  const { server } = buildServer();
  // 经 config.update 写入 approval=auto（等价 UI 切到「完全访问」）。
  await (server as unknown as {
    updateConfig: (p: Record<string, unknown>) => Promise<unknown>;
  }).updateConfig({ approval: 'auto' });
  // bypassSupervisorKernel 是 protected，测试经类型擦除访问。
  const bypassed = (server as unknown as {
    bypassSupervisorKernel: (c: unknown) => unknown;
  }).bypassSupervisorKernel({});
  assert.ok(bypassed !== undefined, 'approval=auto 时应返回 no-op supervisor（bypass）');
  assert.strictEqual(
    (bypassed as { intercept: () => string | undefined }).intercept(),
    undefined,
    'no-op supervisor 不得拦截任何工具',
  );
});

test('app-server：approval=rules 时保持生产级 SupervisorKernel', async () => {
  const { server } = buildServer();
  await (server as unknown as {
    updateConfig: (p: Record<string, unknown>) => Promise<unknown>;
  }).updateConfig({ approval: 'rules' });
  const bypassed = (server as unknown as {
    bypassSupervisorKernel: (c: unknown) => unknown;
  }).bypassSupervisorKernel({});
  assert.strictEqual(bypassed, undefined, 'approval=rules 时应保持生产级 supervisor');
});
