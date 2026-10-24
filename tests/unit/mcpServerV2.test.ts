/**
 * MCP 2026-07-28 服务端判据：`_meta` 校验、discover、resultType、缓存、MRTR、订阅、trace。
 *
 * 覆盖「声明即行为」：每个协议字段都从真实线缆消息（PairTransport / SSE 帧）断言，
 * 不直接调私有方法。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { Transport } from '../../src/server/transport/lineTransport.ts';
import { LineTransport } from '../../src/server/transport/lineTransport.ts';
import type { McpServerOptions } from '../../src/mcp/mcpServer.ts';
import { McpServer } from '../../src/mcp/mcpServer.ts';
import { McpSseResponseTransport } from '../../src/mcp/mcpSseResponseTransport.ts';
import { McpApprovalInputHandler } from '../../src/mcp/mcpApprovalInputHandler.ts';
import { McpAskUserInputHandler } from '../../src/mcp/mcpAskUserInputHandler.ts';
import { McpStatelessClient } from '../../src/mcp/mcpStatelessClient.ts';
import type {
  McpInputRequiredContext,
  McpInputRequiredDecision,
  McpInputRequiredPort,
} from '../../src/ports/mcp/mcpInputRequiredPort.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../src/ports/tool/tool.ts';

/** 双端内存传输（服务端与客户端互联）。 */
class PairTransport implements Transport {
  /** 已发送消息。 */
  public readonly sent: RpcMessage[] = [];
  /** 对端。 */
  public peer: PairTransport | undefined;
  /** 入站回调。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /** 发送并投递到对端。 */
  public send(message: RpcMessage): void {
    this.sent.push(message);
    this.peer?.deliver(message);
  }

  /** 登记入站回调。 */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /** 投递消息。 */
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }
}

/** 互联的一对传输。 */
interface Pair {
  readonly clientSide: PairTransport;
  readonly serverSide: PairTransport;
}

/** 建一对互联传输。 */
function pair(): Pair {
  const clientSide = new PairTransport();
  const serverSide = new PairTransport();
  clientSide.peer = serverSide;
  serverSide.peer = clientSide;
  return { clientSide, serverSide };
}

/** 等若干轮事件循环。 */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 记录调用的工具端口。 */
class RecordingTools implements ToolPort {
  /** 端口名。 */
  public readonly name = 'recording';
  /** 工具定义。 */
  private readonly defs: readonly ToolDefinition[];
  /** 已执行调用。 */
  public readonly calls: ToolCall[] = [];

  /** @param names 工具名（按给定顺序暴露，用于排序断言）。 */
  public constructor(names: readonly string[]) {
    this.defs = names.map((name) => ({
      name,
      description: `工具 ${name}`,
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    }));
  }

  /** 工具清单。 */
  public list(): readonly ToolDefinition[] {
    return this.defs;
  }

  /** 执行（回显）。 */
  public async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { callId: call.id, ok: true, output: `done:${call.name}` };
  }
}

/** 工具执行上下文。 */
function context(): ToolContext {
  return { sessionId: 'mcp-v2-test', workspaceRoot: process.cwd() };
}

/** 现代请求 `_meta`。 */
function modernMeta(
  capabilities: Record<string, unknown> = { elicitation: {} },
): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  };
}

/** 构造服务端（默认 recording 工具 + 现代 meta 方便直接发请求）。 */
function buildServer(overrides: Partial<McpServerOptions> = {}): {
  pair: Pair;
  server: McpServer;
  tools: RecordingTools;
} {
  const p = pair();
  const tools = new RecordingTools(['echo', 'alpha']);
  const server = new McpServer({
    transport: p.serverSide,
    tools,
    context: context(),
    ...overrides,
  });
  return { pair: p, server, tools };
}

/** 发一个请求并取响应。 */
async function request(
  p: Pair,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  p.clientSide.send({ jsonrpc: '2.0', id, method, params });
  await tick();
  const response = p.serverSide.sent.find(
    (message) => 'id' in message && !('method' in message) && (message as { id: number }).id === id,
  ) as { result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined;
  assert.ok(response, `应收到 ${method} 的响应`);
  return response;
}

/** 取结果对象。 */
function resultOf(response: { result?: unknown }): Record<string, unknown> {
  assert.ok(typeof response.result === 'object' && response.result !== null, '结果应为对象');
  return response.result as Record<string, unknown>;
}

/** 断言结果是 complete 且带 serverInfo。 */
function assertDecorated(result: Record<string, unknown>): void {
  assert.strictEqual(result['resultType'], 'complete');
  const meta = result['_meta'] as Record<string, unknown> | undefined;
  assert.ok(meta, '结果必须带 _meta');
  assert.deepStrictEqual(meta?.['io.modelcontextprotocol/serverInfo'], {
    name: 'omniharness',
    version: '0.1.0',
  });
}

test('discover：双版本、能力、extensions、缓存字段与 serverInfo', async () => {
  const { pair: p } = buildServer({ extensions: { 'io.omniharness/demo': { mode: 'test' } } });
  const response = await request(p, 1, 'server/discover', { _meta: modernMeta() });
  const result = resultOf(response);
  assertDecorated(result);
  assert.deepStrictEqual(result['supportedVersions'], ['2026-07-28', '2025-06-18']);
  assert.strictEqual(result['ttlMs'], 300_000);
  assert.strictEqual(result['cacheScope'], 'public');
  const capabilities = result['capabilities'] as Record<string, unknown>;
  assert.deepStrictEqual(capabilities['extensions'], { 'io.omniharness/demo': { mode: 'test' } });
  assert.deepStrictEqual(capabilities['resources'], { subscribe: true, listChanged: true });
});

test('版本校验：不支持的 protocolVersion → -32022 + supported/requested', async () => {
  const { pair: p } = buildServer();
  const response = await request(p, 1, 'tools/list', {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '1900-01-01',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  });
  assert.strictEqual(response.error?.code, -32022);
  assert.deepStrictEqual(response.error?.data, {
    supported: ['2026-07-28', '2025-06-18'],
    requested: '1900-01-01',
  });
});

test('每请求 _meta：现代请求缺 clientCapabilities → -32602', async () => {
  const { pair: p } = buildServer();
  const response = await request(p, 1, 'tools/list', {
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
  });
  assert.strictEqual(response.error?.code, -32602);
});

test('所有结果带 resultType 与 _meta.serverInfo（列表/读取/模板）', async () => {
  const resources = {
    name: 'mem',
    list: async () => [{ uri: 'mem://a', name: 'a' }],
    read: async (uri: string) => ({ uri, text: `body:${uri}` }),
    templates: async () => [{ uriTemplate: 'mem://{id}', name: 'memo' }],
  };
  const prompts = {
    name: 'mem',
    list: async () => [{ name: 'sum' }],
    get: async (name: string) => `prompt:${name}`,
  };
  const { pair: p } = buildServer({ resources, prompts });
  const methods: readonly [string, Record<string, unknown>][] = [
    ['tools/list', {}],
    ['prompts/list', {}],
    ['resources/list', {}],
    ['resources/read', { uri: 'mem://a' }],
    ['resources/templates/list', {}],
    ['prompts/get', { name: 'sum' }],
  ];
  for (const [index, [method, params]] of methods.entries()) {
    const response = await request(p, 10 + index, method, { ...params, _meta: modernMeta() });
    assertDecorated(resultOf(response));
  }
});

test('缓存字段：默认值 + 按方法可配置', async () => {
  const { pair: p } = buildServer({
    cache: { ttlMs: 111, cacheScope: 'public', perMethod: { 'resources/read': { ttlMs: 7 } } },
    resources: {
      name: 'mem',
      list: async () => [],
      read: async (uri: string) => ({ uri, text: 'x' }),
    },
  });
  const tools = resultOf(await request(p, 1, 'tools/list', { _meta: modernMeta() }));
  assert.strictEqual(tools['ttlMs'], 111);
  assert.strictEqual(tools['cacheScope'], 'public');
  const read = resultOf(
    await request(p, 2, 'resources/read', { uri: 'mem://x', _meta: modernMeta() }),
  );
  assert.strictEqual(read['ttlMs'], 7);
  assert.strictEqual(read['cacheScope'], 'private');
});

test('tools/list 保持确定性排序（名字升序）', async () => {
  const { pair: p } = buildServer();
  const result = resultOf(await request(p, 1, 'tools/list', { _meta: modernMeta() }));
  const names = (result['tools'] as { name: string }[]).map((tool) => tool.name);
  assert.deepStrictEqual(names, ['alpha', 'echo']);
});

test('resources/templates/list 返回后端模板并带缓存字段', async () => {
  const { pair: p } = buildServer({
    resources: {
      name: 'mem',
      list: async () => [],
      read: async (uri: string) => ({ uri, text: '' }),
      templates: async () => [{ uriTemplate: 'mem://{id}', name: 'memo' }],
    },
  });
  const result = resultOf(await request(p, 1, 'resources/templates/list', { _meta: modernMeta() }));
  assert.deepStrictEqual(result['resourceTemplates'], [
    { uriTemplate: 'mem://{id}', name: 'memo' },
  ]);
  assert.strictEqual(result['ttlMs'], 60_000);
});

test('resources/read 返回规范 contents 形状', async () => {
  const { pair: p } = buildServer({
    resources: {
      name: 'mem',
      list: async () => [],
      read: async (uri: string) => ({ uri, mimeType: 'text/plain', text: 'hello' }),
    },
  });
  const result = resultOf(
    await request(p, 1, 'resources/read', { uri: 'mem://a', _meta: modernMeta() }),
  );
  assert.deepStrictEqual(result['contents'], [
    { uri: 'mem://a', mimeType: 'text/plain', text: 'hello' },
  ]);
});

test('extensions 能力：显式声明进 discover 与 legacy initialize', async () => {
  const { pair: p } = buildServer({ extensions: { 'io.omniharness/demo': {} } });
  const discovered = resultOf(await request(p, 1, 'server/discover', { _meta: modernMeta() }));
  const capabilities = discovered['capabilities'] as Record<string, unknown>;
  assert.deepStrictEqual(capabilities['extensions'], { 'io.omniharness/demo': {} });
  const legacy = resultOf(await request(p, 2, 'initialize', {}));
  const legacyCaps = legacy['capabilities'] as Record<string, unknown>;
  assert.deepStrictEqual(legacyCaps['extensions'], { 'io.omniharness/demo': {} });
});

test('ping：现代请求被移除（-32601），legacy 请求仍应答', async () => {
  const { pair: p } = buildServer();
  const modern = await request(p, 1, 'ping', { _meta: modernMeta() });
  assert.strictEqual(modern.error?.code, -32601);
  const legacy = await request(p, 2, 'ping', {});
  assert.deepStrictEqual(resultOf(legacy), {
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'omniharness', version: '0.1.0' } },
  });
});

test('订阅：ack 必须是第一条且带 subscriptionId；未订阅类型不发送', async () => {
  const { pair: p, server } = buildServer();
  p.clientSide.send({
    jsonrpc: '2.0',
    id: 7,
    method: 'subscriptions/listen',
    params: { notifications: { toolsListChanged: true }, _meta: modernMeta() },
  });
  await tick();
  const first = p.serverSide.sent[0] as {
    method?: string;
    params?: { _meta?: Record<string, unknown> };
  };
  assert.strictEqual(first.method, 'notifications/subscriptions/acknowledged');
  assert.strictEqual(first.params?._meta?.['io.modelcontextprotocol/subscriptionId'], 7);
  const before = p.serverSide.sent.length;
  assert.strictEqual(server.notifyPromptsChanged(), 0, '未订阅 prompts 不得发送');
  assert.strictEqual(p.serverSide.sent.length, before);
  assert.strictEqual(server.notifyToolsChanged(), 1);
  const notification = p.serverSide.sent.at(-1) as {
    method?: string;
    params?: { _meta?: Record<string, unknown> };
  };
  assert.strictEqual(notification.method, 'notifications/tools/list_changed');
  assert.strictEqual(notification.params?._meta?.['io.modelcontextprotocol/subscriptionId'], 7);
});

test('订阅：resourceSubscriptions 只推送匹配 URI，取消后优雅关闭', async () => {
  const { pair: p, server } = buildServer();
  p.clientSide.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'subscriptions/listen',
    params: {
      notifications: { resourceSubscriptions: ['mem://a'] },
      _meta: modernMeta(),
    },
  });
  await tick();
  assert.strictEqual(server.notifyResourceUpdated('mem://b'), 0);
  assert.strictEqual(server.notifyResourceUpdated('mem://a'), 1);
  const updated = p.serverSide.sent.at(-1) as {
    params?: { uri?: string; _meta?: Record<string, unknown> };
  };
  assert.strictEqual(updated.params?.uri, 'mem://a');
  p.clientSide.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 3 },
  });
  await tick();
  const closed = p.serverSide.sent.at(-1) as {
    id?: number;
    result?: { resultType?: string; _meta?: Record<string, unknown> };
  };
  assert.strictEqual(closed.id, 3);
  assert.strictEqual(closed.result?.resultType, 'complete');
  assert.strictEqual(closed.result?._meta?.['io.modelcontextprotocol/subscriptionId'], 3);
});

test('订阅：server.close 优雅结束全部订阅（完成响应带 subscriptionId）', async () => {
  const { pair: p, server } = buildServer();
  p.clientSide.send({
    jsonrpc: '2.0',
    id: 11,
    method: 'subscriptions/listen',
    params: { notifications: { toolsListChanged: true }, _meta: modernMeta() },
  });
  await tick();
  server.close();
  await tick();
  const closed = p.serverSide.sent.at(-1) as {
    id?: number;
    result?: { resultType?: string; _meta?: Record<string, unknown> };
  };
  assert.strictEqual(closed.id, 11);
  assert.strictEqual(closed.result?.resultType, 'complete');
  assert.strictEqual(closed.result?._meta?.['io.modelcontextprotocol/subscriptionId'], 11);
});

test('stdio（LineTransport）：订阅 ack/通知/优雅关闭都走共享通道，不破坏旧 stdio', async () => {
  const output: string[] = [];
  let feed: ((line: string) => void) | undefined;
  const transport = new LineTransport(
    (onLine) => {
      feed = onLine;
    },
    (line) => output.push(line),
  );
  const server = new McpServer({
    transport,
    tools: new RecordingTools(['echo']),
    context: context(),
  });
  assert.ok(feed !== undefined);
  feed(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true }, _meta: modernMeta() },
    }),
  );
  await tick();
  const ack = JSON.parse(output[0] ?? '{}') as {
    method?: string;
    params?: { _meta?: Record<string, unknown> };
  };
  assert.strictEqual(ack.method, 'notifications/subscriptions/acknowledged');
  assert.strictEqual(ack.params?._meta?.['io.modelcontextprotocol/subscriptionId'], 21);
  server.notifyToolsChanged();
  const notification = JSON.parse(output[1] ?? '{}') as { method?: string };
  assert.strictEqual(notification.method, 'notifications/tools/list_changed');
  feed(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 21 },
    }),
  );
  await tick();
  const closed = JSON.parse(output.at(-1) ?? '{}') as {
    id?: number;
    result?: { resultType?: string };
  };
  assert.strictEqual(closed.id, 21);
  assert.strictEqual(closed.result?.resultType, 'complete');
});

test('SSE 长生命周期 POST：ack+通知+完成响应都写同一响应流，普通请求分流', async () => {
  const streamA: string[] = [];
  const streamB: string[] = [];
  const fallback: string[] = [];
  const transport = new McpSseResponseTransport((frame) => fallback.push(frame.data));
  transport.registerStream(1, (frame) => streamA.push(McpSseResponseTransport.encode(frame)));
  transport.registerStream(2, (frame) => streamB.push(McpSseResponseTransport.encode(frame)));
  const server = new McpServer({
    transport,
    tools: new RecordingTools(['echo']),
    context: context(),
  });
  transport.deliver({
    jsonrpc: '2.0',
    id: 1,
    method: 'subscriptions/listen',
    params: { notifications: { toolsListChanged: true }, _meta: modernMeta() },
  });
  await tick();
  assert.match(streamA[0] ?? '', /notifications\/subscriptions\/acknowledged/u);
  assert.match(streamA[0] ?? '', /subscriptionId":1/u);
  server.notifyToolsChanged();
  assert.match(streamA[1] ?? '', /notifications\/tools\/list_changed/u);
  assert.strictEqual(streamB.length, 0, '订阅通知不得写进别的 POST 流');
  transport.deliver({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: { _meta: modernMeta() },
  });
  await tick();
  assert.match(streamB[0] ?? '', /"resultType":"complete"/u);
  transport.deliver({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 1 },
  });
  await tick();
  assert.match(streamA.at(-1) ?? '', /"resultType":"complete"/u);
  assert.strictEqual(fallback.length, 0);
});

/** 需要一次输入、第二次 allow 的测试 handler。 */
class OneShotInputPort implements McpInputRequiredPort {
  /** 端口名。 */
  public readonly name = 'one-shot';
  /** 评估次数。 */
  public calls = 0;
  /** 第二次评估看到的状态。 */
  public seenState: unknown;

  /** 评估。 */
  public async evaluate(context: McpInputRequiredContext): Promise<McpInputRequiredDecision> {
    this.calls += 1;
    this.seenState = context.state;
    if (context.inputResponses === undefined) {
      return {
        kind: 'input_required',
        inputRequests: {
          confirm: {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: '确认？',
              requestedSchema: { type: 'object', properties: {} },
            },
          },
        },
        state: { ticket: 't-1' },
      };
    }
    const answer = context.inputResponses['confirm'] as
      { action?: string; content?: { answer?: string } } | undefined;
    return answer?.action === 'accept' && answer.content?.answer === 'yes'
      ? { kind: 'allow' }
      : { kind: 'deny', message: '用户拒绝' };
  }
}

test('MRTR：input_required → requestState/inputRequests → 重试执行且仅执行一次', async () => {
  const port = new OneShotInputPort();
  const { pair: p, tools } = buildServer({ inputRequired: port });
  const first = resultOf(
    await request(p, 1, 'tools/call', {
      name: 'echo',
      arguments: { text: 'a' },
      _meta: modernMeta(),
    }),
  );
  assert.strictEqual(first['resultType'], 'input_required');
  assert.ok(typeof first['requestState'] === 'string');
  const retry = resultOf(
    await request(p, 2, 'tools/call', {
      name: 'echo',
      arguments: { text: 'a' },
      inputResponses: { confirm: { action: 'accept', content: { answer: 'yes' } } },
      requestState: first['requestState'],
      _meta: modernMeta(),
    }),
  );
  assert.strictEqual(retry['resultType'], 'complete');
  assert.deepStrictEqual(port.seenState, { ticket: 't-1' });
  assert.strictEqual(tools.calls.length, 1, '重试成功后才执行一次');
});

test('MRTR：篡改 requestState → -32602 且不执行工具', async () => {
  const { pair: p, tools } = buildServer({ inputRequired: new OneShotInputPort() });
  const first = resultOf(
    await request(p, 1, 'tools/call', { name: 'echo', arguments: {}, _meta: modernMeta() }),
  );
  const state = String(first['requestState']);
  const tampered = `${state.slice(0, -2)}xx`;
  const response = await request(p, 2, 'tools/call', {
    name: 'echo',
    arguments: {},
    inputResponses: { confirm: { action: 'accept', content: { answer: 'yes' } } },
    requestState: tampered,
    _meta: modernMeta(),
  });
  assert.strictEqual(response.error?.code, -32602);
  assert.strictEqual(tools.calls.length, 0);
});

test('MRTR：requestState 与参数绑定，换参数重用被拒', async () => {
  const { pair: p } = buildServer({ inputRequired: new OneShotInputPort() });
  const first = resultOf(
    await request(p, 1, 'tools/call', {
      name: 'echo',
      arguments: { text: 'a' },
      _meta: modernMeta(),
    }),
  );
  const response = await request(p, 2, 'tools/call', {
    name: 'echo',
    arguments: { text: 'b' },
    inputResponses: { confirm: { action: 'accept', content: { answer: 'yes' } } },
    requestState: first['requestState'],
    _meta: modernMeta(),
  });
  assert.strictEqual(response.error?.code, -32602);
  assert.match(String(response.error?.message), /不匹配/u);
});

test('MRTR：过期 requestState 被拒', async () => {
  const { pair: p } = buildServer({
    inputRequired: new OneShotInputPort(),
    requestStateTtlMs: -1,
  });
  const first = resultOf(
    await request(p, 1, 'tools/call', { name: 'echo', arguments: {}, _meta: modernMeta() }),
  );
  const response = await request(p, 2, 'tools/call', {
    name: 'echo',
    arguments: {},
    inputResponses: { confirm: { action: 'accept', content: { answer: 'yes' } } },
    requestState: first['requestState'],
    _meta: modernMeta(),
  });
  assert.strictEqual(response.error?.code, -32602);
  assert.match(String(response.error?.message), /过期/u);
});

test('MRTR：客户端未声明 elicitation → -32021 + requiredCapabilities', async () => {
  const { pair: p } = buildServer({ inputRequired: new OneShotInputPort() });
  const response = await request(p, 1, 'tools/call', {
    name: 'echo',
    arguments: {},
    _meta: modernMeta({}),
  });
  assert.strictEqual(response.error?.code, -32021);
  assert.deepStrictEqual(response.error?.data, { requiredCapabilities: { elicitation: {} } });
});

test('MRTR：带回答但缺 requestState → -32602（fail-closed）', async () => {
  const { pair: p } = buildServer({ inputRequired: new OneShotInputPort() });
  const response = await request(p, 1, 'tools/call', {
    name: 'echo',
    arguments: {},
    inputResponses: { confirm: { action: 'accept', content: { answer: 'yes' } } },
    _meta: modernMeta(),
  });
  assert.strictEqual(response.error?.code, -32602);
  assert.match(String(response.error?.message), /缺少 requestState/u);
});

test('MRTR 端到端：ask_user handler + McpStatelessClient 往返', async () => {
  const askUserPort = new McpAskUserInputHandler();
  const tools = new RecordingTools(['ask_user', 'echo']);
  const { clientSide, serverSide } = pair();
  new McpServer({
    transport: serverSide,
    tools,
    context: context(),
    inputRequired: askUserPort,
  });
  const client = new McpStatelessClient({
    transport: clientSide,
    timeoutMs: 1000,
    inputHandler: {
      resolve: async (requests) => requests.map((entry) => ({ id: entry.id, value: 'yes' })),
    },
  });
  const result = await client.callTool('ask_user', {
    questions: [{ id: 'q1', question: '继续吗？' }],
  });
  assert.strictEqual(result.isError, false);
  const text = result.content[0]?.text ?? '';
  assert.match(text, /"q1":"yes"/u);
  assert.strictEqual(tools.calls.length, 0, 'ask_user 由 MRTR 回答，不执行原工具');
  client.close();
});

test('MRTR 端到端：审批 handler 允许/拒绝都走 elicitation', async () => {
  const decisions: string[] = [];
  const handler = new McpApprovalInputHandler(
    {
      name: 'test-approval',
      decide: async () => {
        decisions.push('decide');
        return 'allow';
      },
    },
    { toolNames: ['echo'] },
  );
  const { pair: p } = buildServer({ inputRequired: handler });
  const first = resultOf(
    await request(p, 1, 'tools/call', { name: 'echo', arguments: {}, _meta: modernMeta() }),
  );
  assert.strictEqual(first['resultType'], 'input_required');
  const denied = resultOf(
    await request(p, 2, 'tools/call', {
      name: 'echo',
      arguments: {},
      inputResponses: { approval: { action: 'accept', content: { decision: 'deny' } } },
      requestState: first['requestState'],
      _meta: modernMeta(),
    }),
  );
  assert.strictEqual(denied['isError'], true, '用户拒绝时工具结果 isError');
  assert.strictEqual(decisions.length, 0, '用户拒绝不得触达策略端口');
});

test('trace：请求 traceparent 在结果中派生同 trace 的子 span，并保留 tracestate/baggage', async () => {
  const { pair: p } = buildServer();
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const parentSpan = '00f067aa0ba902b7';
  const response = await request(p, 1, 'tools/list', {
    _meta: {
      ...modernMeta(),
      traceparent: `00-${traceId}-${parentSpan}-01`,
      tracestate: 'vendor=abc',
      baggage: 'k=v',
    },
  });
  const meta = resultOf(response)['_meta'] as Record<string, unknown>;
  const resultTrace = String(meta['traceparent']);
  const [version, resultTraceId, resultSpan] = resultTrace.split('-');
  assert.strictEqual(version, '00');
  assert.strictEqual(resultTraceId, traceId);
  assert.notStrictEqual(resultSpan, parentSpan, '结果应是新子 span');
  assert.strictEqual(meta['tracestate'], 'vendor=abc');
  assert.strictEqual(meta['baggage'], 'k=v');
});

test('legacy 兼容：无 _meta 的 initialize + tools/call 仍工作', async () => {
  const { pair: p, tools } = buildServer();
  const initialized = resultOf(await request(p, 1, 'initialize', {}));
  assert.strictEqual(initialized['protocolVersion'], '2025-06-18');
  const called = resultOf(
    await request(p, 2, 'tools/call', { name: 'echo', arguments: { text: 'legacy' } }),
  );
  assert.strictEqual(called['isError'], false);
  assert.strictEqual(tools.calls.length, 1);
});
