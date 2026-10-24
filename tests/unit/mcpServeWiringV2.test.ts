/**
 * MCP serve 的 SDK 诚实性判据（2026-07-28）：
 *  - 官方 SDK 1.32 只到 2025-11-25：探测结果必须如实暴露、不得声称 2026-07-28；
 *  - `auto` 在 SDK 不支持 2026-07-28 时走内置 custom-v2，并打印 SDK 实际版本与回落原因；
 *  - 显式 `sdk` 允许走 SDK，但结果/横幅声明**实际**协议版本（降级语义）；
 *  - 显式 `v2` 强制内置实现。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ToolDefinition, ToolPort } from '../../src/ports/tool/tool.ts';
import { McpSdkProbe, type McpSdkProbeResult } from '../../src/adapters/mcp/mcpSdkProbe.ts';
import {
  McpServeRunner,
  type McpServeOptions,
  type McpServeResult,
} from '../../src/adapters/mcp/mcpServeRunner.ts';
import { SdkMcpServerAdapter } from '../../src/adapters/mcp/sdkMcpServerAdapter.ts';

/** 最小工具端口。 */
class EmptyTools implements ToolPort {
  /** 端口名。 */
  public readonly name = 'empty';
  /** 工具清单。 */
  public list(): readonly ToolDefinition[] {
    return [];
  }
  /** 执行（不应被调用）。 */
  public async execute(): Promise<never> {
    throw new Error('不应执行工具');
  }
}

/** serve 选项。 */
const OPTIONS: McpServeOptions = {
  tools: new EmptyTools(),
  context: { sessionId: 'mcp-serve-v2', workspaceRoot: process.cwd() },
};

/** SDK 1.32 形态的探测结果。 */
const SDK_LEGACY: McpSdkProbeResult = {
  available: true,
  version: '1.32.0',
  protocolVersion: '2025-11-25',
  supportedProtocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26'],
  supports20260728: false,
  modules: [{ specifier: 'server/mcp.js', ok: true }],
};

/** SDK 支持 2026-07-28 的探测结果。 */
const SDK_MODERN: McpSdkProbeResult = {
  available: true,
  version: '2.0.0',
  protocolVersion: '2026-07-28',
  supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
  supports20260728: true,
  modules: [{ specifier: 'server/mcp.js', ok: true }],
};

/** 等 onSelect 上报（带超时守卫）。 */
function selection(): {
  readonly promise: Promise<McpServeResult>;
  readonly onSelect: (result: McpServeResult) => void;
} {
  let report: ((value: McpServeResult) => void) | undefined;
  const promise = new Promise<McpServeResult>((resolve, reject) => {
    report = resolve;
    setTimeout(() => reject(new Error('serve 模式未上报（超时）')), 5000).unref();
  });
  return { promise, onSelect: (result) => report?.(result) };
}

test('真探测：SDK 1.32 实际协议 2025-11-25，明确不支持 2026-07-28', async () => {
  const probe = await McpSdkProbe.check();
  assert.strictEqual(probe.available, true);
  assert.strictEqual(probe.protocolVersion, '2025-11-25');
  assert.strictEqual(probe.supports20260728, false);
  assert.ok(probe.supportedProtocolVersions?.includes('2025-11-25'));
  assert.strictEqual(SdkMcpServerAdapter.PROTOCOL_VERSION, probe.protocolVersion);
  assert.strictEqual(SdkMcpServerAdapter.supportsProtocol20260728(), false);
});

test('auto：SDK 不支持 2026-07-28 → 内置 custom-v2，并打印 SDK 实际版本', async () => {
  const select = selection();
  const messages: string[] = [];
  let fallbackCalls = 0;
  let sdkCalls = 0;
  const runner = new McpServeRunner({
    probe: async () => SDK_LEGACY,
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
  assert.strictEqual(result.mode, 'custom-v2');
  assert.match(result.detail, /2025-11-25/u);
  assert.deepStrictEqual(result.protocolVersions, ['2026-07-28', '2025-06-18']);
  assert.strictEqual(sdkCalls, 0, 'SDK 不支持现代协议时不得假装走 SDK');
  assert.strictEqual(fallbackCalls, 1, '必须真的启动内置实现');
  const banner = messages.join('');
  assert.match(banner, /2025-11-25/u);
  assert.match(banner, /2026-07-28/u);
  assert.match(banner, /未声称 SDK 提供 2026-07-28/u);
});

test('显式 sdk：允许走 SDK，但声明实际协议版本（不夸大）', async () => {
  const select = selection();
  const messages: string[] = [];
  let sdkCalls = 0;
  const runner = new McpServeRunner({
    probe: async () => SDK_LEGACY,
    createSdkServer: async () => {
      sdkCalls += 1;
    },
    write: (text) => messages.push(text),
  });
  void runner.run({ ...OPTIONS, protocol: 'sdk' }, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(result.mode, 'sdk');
  assert.strictEqual(sdkCalls, 1);
  assert.deepStrictEqual(result.protocolVersions, ['2025-11-25', '2025-06-18', '2025-03-26']);
  assert.doesNotMatch(result.detail, /2026-07-28/u, 'SDK 路径不得声称 2026-07-28');
  assert.match(messages.join(''), /实际协议版本：2025-11-25/u);
});

test('显式 v2：即使 SDK 支持现代协议也走内置双栈', async () => {
  const select = selection();
  let sdkCalls = 0;
  let fallbackCalls = 0;
  const runner = new McpServeRunner({
    probe: async () => SDK_MODERN,
    createSdkServer: async () => {
      sdkCalls += 1;
    },
    createFallbackServer: () => {
      fallbackCalls += 1;
    },
    write: () => undefined,
  });
  void runner.run({ ...OPTIONS, protocol: 'v2' }, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(result.mode, 'custom-v2');
  assert.strictEqual(sdkCalls, 0);
  assert.strictEqual(fallbackCalls, 1);
});

test('auto：SDK 原生支持 2026-07-28 → 走 SDK 并声明完整支持列表', async () => {
  const select = selection();
  let sdkCalls = 0;
  const runner = new McpServeRunner({
    probe: async () => SDK_MODERN,
    createSdkServer: async () => {
      sdkCalls += 1;
    },
    write: () => undefined,
  });
  void runner.run(OPTIONS, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(result.mode, 'sdk');
  assert.strictEqual(sdkCalls, 1);
  assert.deepStrictEqual(result.protocolVersions, ['2026-07-28', '2025-11-25']);
});

test('SDK 不可用：回落内置实现但如实上报原因与实际协议', async () => {
  const select = selection();
  const runner = new McpServeRunner({
    probe: async () => ({
      available: false,
      reason: '未安装依赖包 @modelcontextprotocol/sdk',
      modules: [],
    }),
    createFallbackServer: () => undefined,
    write: () => undefined,
  });
  void runner.run(OPTIONS, select.onSelect);
  const result = await select.promise;
  assert.strictEqual(result.mode, 'fallback');
  assert.match(result.detail, /未安装依赖包/u);
  assert.deepStrictEqual(result.protocolVersions, ['2026-07-28', '2025-06-18']);
});
