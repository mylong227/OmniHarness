// A1（MCP 协议兼容性差距闭合）可证伪验收：
//   ① 官方 SDK 双端（Server+Client）经 InMemoryTransport 直连成功（协议握手 = 官方实现托管）；
//   ② 工具发现：ToolPort.list() 的工具经 registerTool 暴露，client.listTools 可见且 inputSchema 一致；
//   ③ 工具执行往返：client.callTool → ToolPort.execute → content 文本 = harness 结果；失败映射 isError；
//   ④ 多实例隔离：两个 adapter 各自注册不同工具，互不串扰。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SdkMcpServerAdapter } from '../../src/adapters/mcp/sdkMcpServerAdapter.js';
import type {
  ToolPort,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
} from '../../src/ports/tool/tool.js';

/**
 * 测试用内存工具端口桩：记录调用、支持注入失败工具（失败映射验收）。
 */
class FakeToolPort implements ToolPort {
  /** 端口标识名。 */
  public readonly name = 'fake-tool-port';
  /** 已到达 execute 的调用记录（断言「真实到达 ToolPort」用）。 */
  public readonly seen: ToolCall[] = [];
  /** 注册的工具定义。 */
  private readonly defs: ToolDefinition[];
  /** 注入失败的工具名集合（失败映射验收用）。 */
  private readonly fail: ReadonlySet<string>;

  public constructor(defs: ToolDefinition[], fail: ReadonlySet<string> = new Set()) {
    this.defs = defs;
    this.fail = fail;
  }

  /**
   * 返回注册的工具清单。
   * @returns 工具定义只读数组
   */
  public list(): readonly ToolDefinition[] {
    return this.defs;
  }

  /**
   * 执行工具调用（记录调用并按注入的失败集返回）。
   * @param call 工具调用
   * @param _context 工具上下文（未使用）
   * @returns 执行结果
   */
  public async execute(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    this.seen.push(call);
    if (this.fail.has(call.name)) {
      return { callId: call.id, ok: false, error: `工具 ${call.name} 执行失败（注入）` };
    }
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({ echoed: call.arguments, tool: call.name }),
    };
  }
}

const DEFS: ToolDefinition[] = [
  {
    name: 'echo',
    description: '原样回显参数',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的文本' } },
      required: ['message'],
    },
  },
  {
    name: 'boom',
    description: '总是失败的工具（失败映射验收用）',
    parameters: { type: 'object', properties: {} },
  },
];

test('① 官方 SDK 双端握手：InMemoryTransport 直连成功且 serverInfo 正确', async () => {
  const adapter = new SdkMcpServerAdapter(new FakeToolPort(DEFS), {
    name: 'omniharness',
    version: '0.1.0',
  });
  const pair = await adapter.connectInMemory();
  try {
    const serverInfo = await pair.client.getServerVersion();
    assert.strictEqual(serverInfo?.name, 'omniharness');
    assert.strictEqual(serverInfo?.version, '0.1.0');
  } finally {
    await pair.close();
  }
});

test('② 工具发现：listTools 可见全部工具且 inputSchema 透传一致', async () => {
  const adapter = new SdkMcpServerAdapter(new FakeToolPort(DEFS), {
    name: 'omniharness',
    version: '0.1.0',
  });
  const pair = await adapter.connectInMemory();
  try {
    const { tools } = await pair.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['boom', 'echo']);
    const echo = tools.find((t) => t.name === 'echo');
    assert.strictEqual(echo?.description, '原样回显参数');
    assert.deepStrictEqual(
      echo?.inputSchema.required,
      ['message'],
      'inputSchema.required 必须原样透传',
    );
  } finally {
    await pair.close();
  }
});

test('③ 工具执行往返：callTool → ToolPort.execute，成功与失败分别映射', async () => {
  const port = new FakeToolPort(DEFS, new Set(['boom']));
  const adapter = new SdkMcpServerAdapter(port, { name: 'omniharness', version: '0.1.0' });
  const pair = await adapter.connectInMemory();
  try {
    const ok = await pair.client.callTool({ name: 'echo', arguments: { message: '你好 MCP' } });
    assert.ok(!ok.isError, '成功结果 isError 必须为 falsy（SDK 归一为 false）');
    const text = (ok.content as Array<{ type: string; text: string }>).map((c) => c.text).join('');
    assert.match(text, /你好 MCP/);

    const bad = await pair.client.callTool({ name: 'boom', arguments: {} });
    assert.strictEqual(bad.isError, true, '失败必须映射为 isError=true');
    const errText = (bad.content as Array<{ type: string; text: string }>)
      .map((c) => c.text)
      .join('');
    assert.match(errText, /执行失败/);

    assert.strictEqual(port.seen.length, 2, '两次调用都必须真实到达 ToolPort.execute');
    assert.match(port.seen[0]!.id, /^mcp-sdk-/);
  } finally {
    await pair.close();
  }
});

test('④ 多实例隔离：两个 adapter 各自注册，互不串扰', async () => {
  const a = new SdkMcpServerAdapter(new FakeToolPort([DEFS[0]!]), { name: 'a', version: '1' });
  const b = new SdkMcpServerAdapter(new FakeToolPort([DEFS[1]!]), { name: 'b', version: '1' });
  const pa = await a.connectInMemory();
  const pb = await b.connectInMemory();
  try {
    const ta = (await pa.client.listTools()).tools.map((t) => t.name);
    const tb = (await pb.client.listTools()).tools.map((t) => t.name);
    assert.deepStrictEqual(ta, ['echo']);
    assert.deepStrictEqual(tb, ['boom']);
  } finally {
    await pa.close();
    await pb.close();
  }
});
