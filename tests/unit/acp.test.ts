/**
 * ACP v1 协议判据（官方 schema：https://agentclientprotocol.com/protocol/v1/schema）。
 *
 * 覆盖：initialize / session/new / session/load / prompt / 工具事件 / 取消 / 权限请求 / 计划更新，
 * 以及一条**真实 Agent 运行时**（MockModel + ConfigFactory + createRuntime）的端到端映射。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';
import type { EventPort } from '../../src/ports/runtime/eventPort.ts';
import type { ApprovalPort } from '../../src/ports/runtime/approval.ts';
import { eventFactory } from '../../src/core/eventFactory.ts';
import { Agent } from '../../src/core/agent.ts';
import { Runtime } from '../../src/composition/runtime.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import {
  AcpServer,
  AgentAcpSession,
  type AcpPermissionRequest,
  type AcpSessionFactory,
  type AcpSessionOptions,
  type AcpSessionRuntime,
  type AcpSessionUpdate,
  type AcpTransport,
  type AcpRunResult,
} from '../../src/acp/index.ts';

/** 双端内存传输（与 A2A 测试同构）。 */
class MemoryAcpTransport implements AcpTransport {
  public peer: MemoryAcpTransport | undefined;
  public readonly sent: RpcMessage[] = [];
  public readonly received: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.sent.push(message);
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

/** Client 侧测试驱动器：发请求、收集 session/update、响应权限请求。 */
class AcpClient {
  public readonly updates: AcpSessionUpdate[] = [];
  public readonly permissionRequests: {
    readonly id: number;
    readonly params: AcpPermissionRequest;
  }[] = [];
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private nextId = 1;

  public constructor(private readonly transport: MemoryAcpTransport) {
    transport.onMessage((message) => this.onMessage(message));
  }

  public async request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    const response = new Promise<RpcMessage>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.transport.send({ jsonrpc: '2.0', id, method, params } as RpcMessage);
    return await response;
  }

  public notify(method: string, params: unknown): void {
    this.transport.send({ jsonrpc: '2.0', method, params } as RpcMessage);
  }

  public respondPermission(id: number, optionId: string): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      result: { outcome: { outcome: 'selected', optionId } },
    } as RpcMessage);
  }

  private onMessage(message: RpcMessage): void {
    if ('method' in message) {
      const params = (message as { readonly params?: Record<string, unknown> }).params ?? {};
      if (message.method === 'session/update') {
        this.updates.push(params['update'] as AcpSessionUpdate);
        return;
      }
      if (
        message.method === 'session/request_permission' &&
        'id' in message &&
        typeof message.id === 'number'
      ) {
        this.permissionRequests.push({
          id: message.id,
          params: params as unknown as AcpPermissionRequest,
        });
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    this.pending.get(message.id)?.(message);
    this.pending.delete(message.id);
  }
}

/** 可脚本化的假会话运行时。 */
class FakeAcpSession implements AcpSessionRuntime {
  public readonly runs: string[] = [];
  public cancelled = false;
  public decision: string | undefined;
  private readonly events: EventPort;
  private readonly approvals: ApprovalPort;
  private readonly behavior: FakeBehavior;

  public constructor(options: AcpSessionOptions, behavior: FakeBehavior) {
    this.events = options.events;
    this.approvals = options.approvals;
    this.behavior = behavior;
  }

  public async run(prompt: string): Promise<AcpRunResult> {
    this.runs.push(prompt);
    for (const event of this.behavior.events ?? []) this.events.emit(event);
    if (this.behavior.gate !== undefined) await this.behavior.gate;
    if (this.behavior.permission !== undefined) {
      this.decision = await this.approvals.decide({
        sessionId: 'sess',
        toolName: this.behavior.permission.toolName,
        target: this.behavior.permission.target,
      });
      this.events.emit(eventFactory.assistant('sess', `decision:${this.decision}`));
    }
    return {
      finalText: 'done',
      steps: 1,
      aborted: this.cancelled,
      truncated: false,
    };
  }

  public async load(): Promise<readonly SessionEvent[]> {
    return this.behavior.history ?? [];
  }

  public cancel(): void {
    this.cancelled = true;
    this.behavior.release?.();
  }
}

/** 假会话行为。 */
interface FakeBehavior {
  readonly events?: readonly SessionEvent[];
  readonly history?: readonly SessionEvent[];
  readonly gate?: Promise<void>;
  readonly permission?: { readonly toolName: string; readonly target: string };
  readonly release?: () => void;
}

/** 测试装配：server + client + 最近创建的假会话。 */
class Harness {
  public readonly serverTransport = new MemoryAcpTransport();
  public readonly clientTransport = new MemoryAcpTransport();
  public readonly client: AcpClient;
  public readonly server: AcpServer;
  public session: FakeAcpSession | undefined;

  public constructor(behavior: FakeBehavior, permissionMode: 'client' | 'auto' = 'client') {
    this.clientTransport.peer = this.serverTransport;
    this.serverTransport.peer = this.clientTransport;
    this.client = new AcpClient(this.clientTransport);
    const factory: AcpSessionFactory = async (options) => {
      this.session = new FakeAcpSession(options, behavior);
      return this.session;
    };
    this.server = new AcpServer({
      transport: this.serverTransport,
      sessionFactory: factory,
      permissionMode,
      permissionTimeoutMs: 2_000,
    });
    // 传输监听在 run() 里注册；测试不等待进程关闭，但必须启动监听。
    void this.server.run();
  }

  public async newSession(cwd: string): Promise<string> {
    const response = await this.client.request('session/new', { cwd, mcpServers: [] });
    const result = (response as { readonly result?: { readonly sessionId?: string } }).result;
    assert.ok(result?.sessionId, `session/new 必须返回 sessionId：${JSON.stringify(response)}`);
    return result.sessionId;
  }
}

/** 轮询等待满足条件的条目（测试桩事件是微任务级，5ms 足够）。 */
async function waitFor<T>(
  items: () => readonly T[],
  predicate: (item: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = items().find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

/** 创建一个延迟控制闸。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'omni-acp-'));
}

test('1) initialize：协商协议版本 1 并声明 loadSession / prompt / MCP 能力', async () => {
  const harness = new Harness({});
  const pending = harness.client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true }, terminal: true },
    clientInfo: { name: 'zed', version: '1.0.0' },
  });
  const response = await pending;
  const result = (response as { readonly result?: Record<string, unknown> }).result;
  assert.strictEqual(result?.['protocolVersion'], 1);
  const capabilities = result?.['agentCapabilities'] as Record<string, unknown>;
  assert.strictEqual(capabilities['loadSession'], true);
  assert.deepStrictEqual(capabilities['promptCapabilities'], {
    image: false,
    audio: false,
    embeddedContext: true,
  });
  const info = result?.['agentInfo'] as { name?: string };
  assert.strictEqual(info.name, 'omniharness');
});

test('2) session/new：返回会话 id；cwd 非绝对路径 fail-closed', async () => {
  const harness = new Harness({});
  const cwd = tempDir();
  const sessionId = await harness.newSession(cwd);
  assert.match(sessionId, /^sess_/u);
  const relative = await harness.client.request('session/new', {
    cwd: 'relative/path',
    mcpServers: [],
  });
  const error = (relative as { readonly error?: { readonly code?: number } }).error;
  assert.strictEqual(error?.code, -32602, '相对 cwd 必须按非法参数拒绝');
});

test('3) session/prompt：回写 agent_message_chunk 并以 end_turn 结束', async () => {
  const harness = new Harness({
    events: [eventFactory.assistant('sess', '你好，我是 OmniHarness')],
  });
  const sessionId = await harness.newSession(tempDir());
  const response = await harness.client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '打个招呼' }],
  });
  const result = (response as { readonly result?: { readonly stopReason?: string } }).result;
  assert.strictEqual(result?.stopReason, 'end_turn');
  const chunk = await waitFor(
    () => harness.client.updates,
    (update) => update.sessionUpdate === 'agent_message_chunk',
  );
  assert.strictEqual(
    (chunk as { readonly content?: { readonly text?: string } }).content?.text,
    '你好，我是 OmniHarness',
  );
  assert.deepStrictEqual(harness.session?.runs, ['打个招呼']);
});

test('4) 工具事件：tool_call（含标题/类别）→ tool_call_update completed（含结果文本）', async () => {
  const harness = new Harness({
    events: [
      eventFactory.toolCall('sess', 'call-1', 'read_file', { path: 'src/a.ts' }),
      eventFactory.toolResult('sess', 'call-1', true, 'console.log(1)'),
    ],
  });
  const sessionId = await harness.newSession(tempDir());
  await harness.client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '读文件' }],
  });
  const start = await waitFor(
    () => harness.client.updates,
    (update) => update.sessionUpdate === 'tool_call',
  );
  const startRecord = start as unknown as Record<string, unknown>;
  assert.strictEqual(startRecord['toolCallId'], 'call-1');
  assert.strictEqual(startRecord['kind'], 'read');
  assert.match(String(startRecord['title']), /src\/a\.ts/u);
  const done = await waitFor(
    () => harness.client.updates,
    (update) => update.sessionUpdate === 'tool_call_update',
  );
  const doneRecord = done as unknown as Record<string, unknown>;
  assert.strictEqual(doneRecord['status'], 'completed');
  const content = doneRecord['content'] as { content?: { text?: string } }[];
  assert.strictEqual(content[0]?.content?.text, 'console.log(1)');
});

test('5) session/cancel：挂起回合被中止，prompt 以 cancelled 收尾', async () => {
  const gate = deferred();
  const harness = new Harness({ gate: gate.promise, release: gate.resolve });
  const sessionId = await harness.newSession(tempDir());
  const pending = harness.client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '长任务' }],
  });
  await waitFor(
    () => harness.session?.runs ?? [],
    (run) => run === '长任务',
  );
  harness.client.notify('session/cancel', { sessionId });
  const response = await pending;
  const result = (response as { readonly result?: { readonly stopReason?: string } }).result;
  assert.strictEqual(result?.stopReason, 'cancelled', '取消必须以 cancelled 结束而非内部错误');
  assert.strictEqual(harness.session?.cancelled, true);
});

test('6) 权限请求：写类工具发 session/request_permission，选中 allow 后放行', async () => {
  const harness = new Harness({
    permission: { toolName: 'write_file', target: 'src/a.ts' },
  });
  const sessionId = await harness.newSession(tempDir());
  const pending = harness.client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '写文件' }],
  });
  const request = await waitFor(
    () => harness.client.permissionRequests,
    () => true,
  );
  assert.strictEqual(request.params.toolCall.toolCallId.startsWith('perm-'), true);
  assert.match(String(request.params.toolCall.title), /write_file/u);
  const kinds = request.params.options.map((option) => option.kind);
  assert.ok(kinds.includes('allow_once') && kinds.includes('reject_once'));
  harness.client.respondPermission(request.id, 'allow-once');
  const response = await pending;
  assert.strictEqual(
    (response as { readonly result?: { readonly stopReason?: string } }).result?.stopReason,
    'end_turn',
  );
  assert.strictEqual(harness.session?.decision, 'allow');
});

test('7) 计划/待办事件：映射为 plan 更新（done→completed、in_progress 保留）', async () => {
  const harness = new Harness({
    events: [
      eventFactory.plan('sess', {
        title: '计划',
        steps: [{ description: '第一步', status: 'done' }, { description: '第二步' }],
        status: 'drafting',
      }),
      eventFactory.todo('sess', [
        { content: '进行中', status: 'in_progress' },
        { content: '待办', status: 'pending' },
      ]),
    ],
  });
  const sessionId = await harness.newSession(tempDir());
  await harness.client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '做计划' }],
  });
  const plan = await waitFor(
    () => harness.client.updates,
    (update) => update.sessionUpdate === 'plan',
  );
  const entries = (plan as unknown as { readonly entries: { content: string; status: string }[] })
    .entries;
  assert.deepStrictEqual(
    entries.map((entry) => [entry.content, entry.status]),
    [
      ['第一步', 'completed'],
      ['第二步', 'pending'],
    ],
  );
  const todoPlan = await waitFor(
    () => harness.client.updates.filter((update) => update.sessionUpdate === 'plan'),
    (update) =>
      (update as unknown as { readonly entries: { content: string }[] }).entries[0]?.content ===
      '进行中',
  );
  const todoEntries = (todoPlan as unknown as { readonly entries: { status: string }[] }).entries;
  assert.deepStrictEqual(
    todoEntries.map((entry) => entry.status),
    ['in_progress', 'pending'],
  );
});

test('8) session/load：回放历史（user_message_chunk + agent_message_chunk）', async () => {
  const harness = new Harness({
    history: [
      eventFactory.user('sess', '你好'),
      eventFactory.assistant('sess', '你好，有什么可以帮你'),
    ],
  });
  const sessionId = 'sess-load-1';
  const response = await harness.client.request('session/load', {
    sessionId,
    cwd: tempDir(),
    mcpServers: [],
  });
  assert.deepStrictEqual((response as { readonly result?: unknown }).result, {});
  const updates = harness.client.updates;
  assert.deepStrictEqual(
    updates.map((update) => update.sessionUpdate),
    ['user_message_chunk', 'agent_message_chunk'],
  );
});

test('9) 真实 Agent 运行时：MockModel 的工具回路映射为 ACP 工具事件 + 最终文本', async () => {
  const dir = tempDir();
  const serverTransport = new MemoryAcpTransport();
  const clientTransport = new MemoryAcpTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  const client = new AcpClient(clientTransport);
  const factory: AcpSessionFactory = async (options) => {
    const config = ConfigFactory.build({
      workspaceRoot: options.cwd,
      maxSteps: 3,
      model: new MockModel(),
      storage: new MemoryStorage(),
      approvals: options.approvals,
      sandbox: new PassthroughSandbox(),
      events: options.events,
    });
    return new AgentAcpSession(new Agent(Runtime.createRuntime(config)), options.sessionId);
  };
  const server = new AcpServer({
    transport: serverTransport,
    sessionFactory: factory,
    permissionMode: 'auto',
    permissionTimeoutMs: 2_000,
  });
  void server.run();
  try {
    const newSession = await client.request('session/new', { cwd: dir, mcpServers: [] });
    const sessionId = (newSession as { readonly result?: { readonly sessionId?: string } }).result
      ?.sessionId;
    assert.ok(sessionId);
    const response = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'echo 一下' }],
    });
    assert.strictEqual(
      (response as { readonly result?: { readonly stopReason?: string } }).result?.stopReason,
      'end_turn',
    );
    const kinds = new Set(client.updates.map((update) => update.sessionUpdate));
    assert.ok(kinds.has('tool_call'), `缺 tool_call：${JSON.stringify([...kinds])}`);
    assert.ok(kinds.has('tool_call_update'), '缺 tool_call_update');
    const text = client.updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update as { readonly content?: { readonly text?: string } }).content?.text)
      .join('');
    assert.match(text, /任务完成/u);
    assert.ok(serverTransport.sent.length > 0);
    server.close();
  } finally {
    server.close();
  }
}, 60_000);
