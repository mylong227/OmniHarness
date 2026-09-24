import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import { McpServer } from '../../src/mcp/mcpServer.js';
import { McpClient } from '../../src/mcp/mcpClient.js';
import { McpGateway } from '../../src/mcp/mcpGateway.js';
import { McpProtocol } from '../../src/mcp/mcpProtocol.js';
import { mcpToolMapper } from '../../src/mcp/mcpToolMapper.js';
import { parseMcpServerSpec } from '../../src/mcp/mcpServerCommand.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { DenyApproval } from '../../src/adapters/approval/denyApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { ToolGate } from '../../src/core/toolGate.js';
import type { ResourcePort, PromptPort } from '../../src/mcp/mcpServer.js';
import type { ToolCall, ToolContext, ToolResult } from '../../src/ports/tool/tool.js';

/** 双端内存传输（服务端与客户端互联）。 */
class PairTransport implements Transport {
  public readonly sent: RpcMessage[] = [];
  public peer: PairTransport | undefined;
  private callback: ((message: RpcMessage) => void) | undefined;

  public send(message: RpcMessage): void {
    this.sent.push(message);
    this.peer?.deliver(message);
  }

  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /** 接收对端消息。 */
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }
}

/** 建一对互联传输。 */
function pair(): { clientSide: PairTransport; serverSide: PairTransport } {
  const clientSide = new PairTransport();
  const serverSide = new PairTransport();
  clientSide.peer = serverSide;
  serverSide.peer = clientSide;
  return { clientSide, serverSide };
}

/** 构造本地工具注册表（echo/upper）。 */
function buildRegistry(): RegistryToolPort {
  const registry = new RegistryToolPort();
  registry.register(
    {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      ok: true,
      output: String(call.arguments['text'] ?? ''),
    }),
  );
  return registry;
}

/** 工具执行上下文。 */
function toolContext(): ToolContext {
  return { sessionId: 'test-session', workspaceRoot: process.cwd() };
}

/** 构造 MCP 服务端 + 客户端（互联）。 */
function buildLinked(
  opts: { gate?: ToolGate; resources?: ResourcePort; prompts?: PromptPort } = {},
): { client: McpClient } {
  const { clientSide, serverSide } = pair();
  new McpServer({
    transport: serverSide,
    tools: buildRegistry(),
    context: toolContext(),
    gate: opts.gate,
    resources: opts.resources,
    prompts: opts.prompts,
  });
  return { client: new McpClient({ transport: clientSide }) };
}

test('MCP 服务端：initialize 返回协议版本与 tools 能力', async () => {
  const { client } = buildLinked();
  const info = await client.initialize();
  assert.strictEqual(info.protocolVersion, McpProtocol.PROTOCOL_VERSION);
  assert.strictEqual(info.serverInfo.name, 'omniharness');
  assert.ok('tools' in info.capabilities);
});

test('MCP 协议版本已对齐当前稳定版 2025-06-18（与主流客户端互操作）', () => {
  assert.strictEqual(McpProtocol.PROTOCOL_VERSION, '2025-06-18');
});

test('MCP 服务端：initialize 声明 resources 与 prompts 能力', async () => {
  const { client } = buildLinked();
  const info = await client.initialize();
  assert.ok('resources' in info.capabilities, '应声明 resources 能力');
  assert.ok('prompts' in info.capabilities, '应声明 prompts 能力');
});

test('MCP 服务端：未配置后端时 resources/list 与 prompts/list 返回空列表（不伪造）', async () => {
  const { client } = buildLinked();
  await client.initialize();
  assert.deepStrictEqual(await client.listResources(), []);
  assert.deepStrictEqual(await client.listPrompts(), []);
});

test('MCP 服务端：注入资源后端后 resources/list + resources/read 可用', async () => {
  const resources: ResourcePort = {
    name: 'mem',
    list: async () => [{ uri: 'mem://notes', name: 'notes' }],
    read: async (uri) => ({ uri, text: `内容:${uri}` }),
  };
  const { client } = buildLinked({ resources });
  await client.initialize();
  const list = await client.listResources();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0]?.uri, 'mem://notes');
  const content = await client.readResource('mem://notes');
  assert.strictEqual(content.text, '内容:mem://notes');
});

test('MCP 服务端：注入提示后端后 prompts/list + prompts/get 可用', async () => {
  const prompts: PromptPort = {
    name: 'mem',
    list: async () => [{ name: 'summarize', description: '摘要' }],
    get: async (name) => `提示模板:${name}`,
  };
  const { client } = buildLinked({ prompts });
  await client.initialize();
  const list = await client.listPrompts();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0]?.name, 'summarize');
  const text = await client.getPrompt('summarize');
  assert.strictEqual(text, '提示模板:summarize');
});

test('MCP 服务端：tools/list 返回本地工具与 inputSchema', async () => {
  const { client } = buildLinked();
  await client.initialize();
  const tools = await client.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0]?.name, 'echo');
  assert.strictEqual(tools[0]?.inputSchema.type, 'object');
  assert.deepStrictEqual(tools[0]?.inputSchema.required, ['text']);
});

test('MCP 服务端：tools/call 执行本地工具并返回文本内容', async () => {
  const { client } = buildLinked();
  await client.initialize();
  const result = await client.callTool('echo', { text: '你好' });
  assert.strictEqual(result.isError, false);
  assert.strictEqual(result.content[0]?.text, '你好');
});

test('MCP 服务端：未知工具收敛为 isError 结果（不抛协议错误）', async () => {
  const { client } = buildLinked();
  await client.initialize();
  const result = await client.callTool('nope', {});
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /未知工具/);
});

test('MCP 服务端：注入门禁后外部调用被拦截（fail-closed）', async () => {
  const gate = new ToolGate(new DenyApproval(), new PassthroughSandbox());
  const { client } = buildLinked({ gate });
  await client.initialize();
  const result = await client.callTool('echo', { text: '被拦' });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /拒绝/);
});

test('MCP 客户端：close() 立即拒绝在途请求（不等超时）', async () => {
  // 无对端的传输 ⇒ 请求永不回应。超时故意设成 60s：若 close() 没生效，本用例会挂 60s 才算失败。
  const transport = new PairTransport();
  const client = new McpClient({ transport, timeoutMs: 60_000 });
  const inflight = client.listTools();
  const startedAt = Date.now();
  client.close('测试关闭');
  await assert.rejects(inflight, /MCP 连接已关闭|测试关闭/);
  assert.ok(
    Date.now() - startedAt < 1000,
    'close() 必须立即拒绝在途请求（审计 §3.5：Transport 无关闭通知 ⇒ 原先只能等超时）',
  );
  // 关闭后新请求同样快速失败（而不是又被挂起）
  await assert.rejects(client.listTools(), /已关闭/);
  // 幂等：重复关闭无副作用
  client.close();
});

test('MCP 工具映射：本地定义与 MCP 描述双向转换', () => {
  const definition = {
    name: 'read_file',
    description: '读文件',
    parameters: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  };
  const descriptor = mcpToolMapper.toDescriptor(definition);
  assert.strictEqual(descriptor.inputSchema.type, 'object');
  const back = mcpToolMapper.toDefinition(descriptor);
  assert.deepStrictEqual(back, definition);
});

test('MCP 网关：连接真实子进程服务器并桥接工具', async () => {
  const registry = new RegistryToolPort();
  const gateway = new McpGateway({
    registry,
    context: toolContext(),
    servers: [{ name: 'test', command: process.execPath, args: [fixturePath()] }],
  });
  try {
    const results = await gateway.connectAll();
    assert.strictEqual(results[0]?.error, undefined);
    assert.deepStrictEqual(results[0]?.tools, ['test__echo', 'test__boom']);
    assert.ok(registry.list().some((tool) => tool.name === 'test__echo'));

    const result = await registry.execute(
      { id: 'c1', name: 'test__echo', arguments: { text: '桥接成功' } },
      toolContext(),
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.output, 'echo:桥接成功');
  } finally {
    gateway.close();
  }
});

test('MCP 网关：远端工具报错收敛为 ok:false', async () => {
  const registry = new RegistryToolPort();
  const gateway = new McpGateway({
    registry,
    context: toolContext(),
    servers: [{ name: 'test', command: process.execPath, args: [fixturePath()] }],
  });
  try {
    await gateway.connectAll();
    const result = await registry.execute(
      { id: 'c2', name: 'test__boom', arguments: {} },
      toolContext(),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /boom/);
  } finally {
    gateway.close();
  }
});

test('MCP 网关：服务器启动失败不影响其他服务器且记录错误', async () => {
  const registry = new RegistryToolPort();
  const gateway = new McpGateway({
    registry,
    context: toolContext(),
    servers: [{ name: 'broken', command: 'omniharness-no-such-command' }],
  });
  try {
    const results = await gateway.connectAll();
    assert.ok(results[0]?.error !== undefined);
    assert.strictEqual(results[0]?.tools.length, 0);
  } finally {
    gateway.close();
  }
});

test('MCP 参数解析：NAME=COMMAND ARGS 拆分正确', () => {
  const config = parseMcpServerSpec('fs=node server.js --port 1');
  assert.strictEqual(config.name, 'fs');
  assert.strictEqual(config.command, 'node');
  assert.deepStrictEqual(config.args, ['server.js', '--port', '1']);
});

/** 夹具脚本路径（dist/tests/fixtures/mcpEchoServer.js）。 */
function fixturePath(): string {
  return fileURLToPath(new URL('../fixtures/mcpEchoServer.js', import.meta.url));
}
