/**
 * MCP serve 接线单测：`omniharness mcp serve` 默认走官方 SDK 适配器（A1）。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`src/adapters/mcp/sdkMcpServerAdapter.ts` 写了、
 * 有单测，却没有任何生产接线点——`mcp serve` 只用手写实现。本文件钉住接线后的行为：
 *   ① SDK 可用 → 走 SDK 适配器（工具端口真被交给 SDK 工厂，且带门禁包装）；
 *   ② SDK 不可用 → 回落手写实现，且**如实打印原因**（绝不静默）；
 *   ③ SDK 可用但启动失败 → 同样回落并报出失败原因；
 *   ④ 真官方 SDK 探测可加载（诚实探测的证据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatedToolPort } from '../../src/adapters/mcp/gatedToolPort.js';
import { McpSdkProbe, type McpSdkProbeResult } from '../../src/adapters/mcp/mcpSdkProbe.js';
import { McpServeRunner, type McpServeOptions } from '../../src/adapters/mcp/mcpServeRunner.js';
import {
  SdkMcpServerAdapter,
  type SdkServerInfo,
} from '../../src/adapters/mcp/sdkMcpServerAdapter.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../src/ports/tool/tool.js';
import type { ToolGate } from '../../src/core/toolGate.js';

/** 测试用工具端口：记录调用，供断言「SDK 工具集真到 ToolPort」。 */
class FakeToolPort implements ToolPort {
  /** 端口名（GatedToolPort 会在此名后追加 +gated）。 */
  public readonly name = 'fake-tools';
  /** 已到达 execute 的调用记录。 */
  public readonly seen: ToolCall[] = [];
  /** 工具定义。 */
  private readonly defs: ToolDefinition[];

  /**
   * @param defs 工具定义
   */
  public constructor(defs: ToolDefinition[]) {
    this.defs = defs;
  }

  /**
   * 工具清单。
   * @returns 工具定义只读数组
   */
  public list(): readonly ToolDefinition[] {
    return this.defs;
  }

  /**
   * 执行工具（记录调用）。
   * @param call 工具调用
   * @returns 成功结果
   */
  public async execute(call: ToolCall): Promise<ToolResult> {
    this.seen.push(call);
    return { callId: call.id, ok: true, output: `echo:${call.name}` };
  }
}

/** 测试用门禁：按注入的裁决拒绝或放行，并记录门禁调用。 */
class FakeGate {
  /** 已到达门禁的调用记录。 */
  public readonly gated: ToolCall[] = [];
  /** 裁决（allow / deny）。 */
  private readonly decision: 'allow' | 'deny';

  /**
   * @param decision 门禁裁决
   */
  public constructor(decision: 'allow' | 'deny') {
    this.decision = decision;
  }

  /**
   * 门禁裁决。
   * @param call 工具调用
   * @returns 拒绝时回 ok:false 结果；放行回 undefined
   */
  public async gate(call: ToolCall): Promise<ToolResult | undefined> {
    this.gated.push(call);
    return this.decision === 'deny'
      ? { callId: call.id, ok: false, error: '门禁拒绝（测试）' }
      : undefined;
  }
}

/** 造工具定义。 */
const DEFS: ToolDefinition[] = [
  {
    name: 'echo',
    description: '回显',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/** serve 选项样本。 */
const OPTIONS: McpServeOptions = {
  tools: new FakeToolPort(DEFS),
  context: { sessionId: 'mcp-test', workspaceRoot: process.cwd() },
  serverInfo: { name: 'omniharness', version: '0.1.0' },
};

/** 探针桩：SDK 可用。 */
const SDK_OK: McpSdkProbeResult = {
  available: true,
  version: '9.9.9',
  modules: [{ specifier: 'server/mcp.js', ok: true }],
};

/** 探针桩：SDK 未安装。 */
const SDK_MISSING: McpSdkProbeResult = {
  available: false,
  reason: '未安装依赖包 @modelcontextprotocol/sdk',
  modules: [],
};

/** 模式上报。 */
interface Selection {
  /** 实际生效的实现。 */
  readonly mode: string;
  /** 判断依据。 */
  readonly detail: string;
}

/**
 * 等 `onSelect` 上报模式（带超时守卫，避免测试挂死）。
 * @returns 上报 Promise 与 onSelect 回调
 */
function selection(): {
  promise: Promise<Selection>;
  onSelect: (result: { mode: 'sdk' | 'fallback'; detail: string }) => void;
} {
  let report: ((value: Selection) => void) | undefined;
  const promise = new Promise<Selection>((resolve, reject) => {
    report = resolve;
    setTimeout(() => reject(new Error('serve 模式未上报（超时）')), 5000).unref();
  });
  return { promise, onSelect: (result) => report?.(result) };
}

test('① SDK 可用：serve 走 SDK 适配器，工具端口带门禁包装并交给 SDK 工厂', async () => {
  const gate = new FakeGate('deny');
  const options: McpServeOptions = { ...OPTIONS, gate: gate as unknown as ToolGate };
  const select = selection();
  let handed: ToolPort | undefined;
  let handedInfo: SdkServerInfo | undefined;
  let handedSession: string | undefined;
  const runner = new McpServeRunner({
    probe: async () => SDK_OK,
    createSdkServer: async (tools, info, sessionId) => {
      handed = tools;
      handedInfo = info;
      handedSession = sessionId;
    },
    write: () => undefined,
  });

  const pending = runner.run(options, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(
    result.mode,
    'sdk',
    `SDK 可用时必须走 SDK，实际 ${result.mode}（${result.detail}）`,
  );
  assert.match(result.detail, /9\.9\.9/);
  assert.ok(handed instanceof GatedToolPort, 'SDK 路径的工具端口必须先过门禁包装');
  assert.strictEqual(handed?.name, 'fake-tools+gated');
  assert.deepStrictEqual(handedInfo, { name: 'omniharness', version: '0.1.0' });
  assert.strictEqual(handedSession, 'mcp-test');
  assert.strictEqual(pending instanceof Promise, true, 'serve 是常驻服务（返回未决 Promise）');
});

test('② 门禁语义不因换实现丢失：SDK 路径的调用先过 ToolGate', async () => {
  const inner = new FakeToolPort(DEFS);
  const gate = new FakeGate('deny');
  const options: McpServeOptions = {
    tools: inner,
    context: { sessionId: 'mcp-test', workspaceRoot: process.cwd() },
    gate: gate as unknown as ToolGate,
  };
  const select = selection();
  let handed: ToolPort | undefined;
  const runner = new McpServeRunner({
    probe: async () => SDK_OK,
    createSdkServer: async (tools) => {
      handed = tools;
    },
    write: () => undefined,
  });
  void runner.run(options, select.onSelect);
  await select.promise;

  const call: ToolCall = { id: 'c1', name: 'echo', arguments: { text: 'x' } };
  const context: ToolContext = { sessionId: 'mcp-test', workspaceRoot: process.cwd() };
  const denied = await handed?.execute(call, context);
  assert.strictEqual(gate.gated.length, 1, '门禁必须被调用');
  assert.strictEqual(denied?.ok, false, '门禁拒绝时不得执行工具');
  assert.strictEqual(inner.seen.length, 0, '被拒绝的调用不得触达真实工具');
});

test('③ SDK 不可用：回落手写实现，且如实打印原因（绝不静默降级）', async () => {
  const select = selection();
  const messages: string[] = [];
  let fallbackCalls = 0;
  let sdkCalls = 0;
  const runner = new McpServeRunner({
    probe: async () => SDK_MISSING,
    createSdkServer: async () => {
      sdkCalls += 1;
    },
    createFallbackServer: () => {
      fallbackCalls += 1;
    },
    write: (text) => messages.push(text),
  });

  void runner.run(OPTIONS, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(result.mode, 'fallback');
  assert.match(result.detail, /未安装依赖包/);
  assert.strictEqual(sdkCalls, 0, 'SDK 不可用时不得尝试 SDK 路径');
  assert.strictEqual(fallbackCalls, 1, '必须真的启动手写实现');
  assert.match(messages.join(''), /SDK 不可用.*未安装依赖包/, '回落原因必须打印（stderr）');
});

test('④ SDK 可用但启动失败：同样回落并报出失败原因', async () => {
  const select = selection();
  const messages: string[] = [];
  let fallbackCalls = 0;
  const runner = new McpServeRunner({
    probe: async () => SDK_OK,
    createSdkServer: async () => {
      throw new Error('transport 初始化失败');
    },
    createFallbackServer: () => {
      fallbackCalls += 1;
    },
    write: (text) => messages.push(text),
  });

  void runner.run(OPTIONS, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(result.mode, 'fallback');
  assert.match(result.detail, /transport 初始化失败/);
  assert.strictEqual(fallbackCalls, 1);
  assert.match(messages.join(''), /SDK 启动失败.*transport 初始化失败/);
});

test('⑤ 真探测：本机官方 SDK 的必需子路径可实载并报出版本', async () => {
  const probe = await McpSdkProbe.check();
  assert.strictEqual(
    probe.available,
    true,
    `官方 SDK 必需模块应可加载，实际原因：${probe.reason ?? '(无)'}`,
  );
  assert.match(probe.version ?? '', /^\d+\.\d+\.\d+/);
  assert.ok(probe.modules.length >= 4, '探测必须逐条给出所用子路径的装载结果');
  assert.ok(
    probe.modules.every((entry) => entry.ok),
    '全部必需子路径都必须实载成功',
  );
});

test('⑥ 真适配器：SDK 双端 in-memory 往返暴露 harness 工具', async () => {
  const adapter = new SdkMcpServerAdapter(new FakeToolPort(DEFS), {
    name: 'omniharness',
    version: '0.1.0',
  });
  const pair = await adapter.connectInMemory();
  try {
    const tools = (await pair.client.listTools()).tools.map((entry) => entry.name);
    assert.deepStrictEqual(tools, ['echo'], 'SDK 服务端必须暴露 harness 工具清单');
  } finally {
    await pair.close();
  }
});
