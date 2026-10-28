/**
 * A2：工具 schema 预算 + MCP 后注册工具可检索（2026-10-29）。
 *
 * 缺陷现场：
 *  ① `ToolIndex` 在 `configToolRegistry` 里按当时的 `registry.list()` 建好就固定；
 *     MCP 桥接/插件热加载发生在之后 ⇒ `tool_search` 永远搜不到后注册工具。
 *  ② 类别/BM25 只判相关性，不判 token 预算 ⇒ 后注册工具"未登记类别 ⇒ 恒可见"，
 *     规划器的收益被无上限的工具面直接抵消。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ToolExposurePlanner } from '../../src/core/toolExposurePlanner.ts';
import { ToolIndex } from '../../src/search/toolIndex.ts';
import { ToolSearchTool } from '../../src/adapters/tool/meta/toolSearchTool.ts';
import type { ToolDefinition } from '../../src/ports/tool/tool.ts';
import type { ToolDiscoveryPort } from '../../src/ports/tool/toolDiscoveryPort.ts';

/** 造一个工具定义。 */
function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description } },
      required: [],
    },
  };
}

/** 内存版发现寄存器。 */
class Discovery implements ToolDiscoveryPort {
  private readonly found = new Map<string, ToolDefinition>();
  public add(specs: readonly ToolDefinition[]): void {
    for (const spec of specs) this.found.set(spec.name, spec);
  }
  public list(): readonly ToolDefinition[] {
    return [...this.found.values()];
  }
  public has(name: string): boolean {
    return this.found.has(name);
  }
}

test('tool_search：后注册工具（MCP/插件）经 toolsProvider 惰性重建后可检索', async () => {
  const initial = [tool('read_file', 'read a file')];
  const index = new ToolIndex(initial);
  let live: readonly ToolDefinition[] = initial;
  const discovery = new Discovery();
  const search = new ToolSearchTool(index, discovery, () => live);

  const before = await search.handle(
    { id: 'c0', name: 'tool_search', arguments: { query: 'quantum widget' } },
    { sessionId: 's', workspaceRoot: '/tmp' },
  );
  assert.strictEqual(JSON.parse(String(before.output)).count, 0, '未注册时搜不到');

  live = [...initial, tool('mcp__quantum__run', 'run a quantum widget experiment')];
  const after = await search.handle(
    { id: 'c1', name: 'tool_search', arguments: { query: 'quantum widget' } },
    { sessionId: 's', workspaceRoot: '/tmp' },
  );
  const payload = JSON.parse(String(after.output)) as { tools: { name: string }[] };
  assert.ok(
    payload.tools.some((entry) => entry.name === 'mcp__quantum__run'),
    '后注册工具必须能被 tool_search 检索到',
  );
  assert.ok(discovery.has('mcp__quantum__run'), '命中必须登记进发现表（下一回合可见）');
});

test('boundBySchemaBudget：按 schema token 预算收窄，恒可见工具永不被挤掉', () => {
  const tools = Array.from({ length: 20 }, (_, index) =>
    tool(`tool_${String(index)}`, 'x'.repeat(4000)),
  );
  // 恒可见工具放最后：预算早该耗尽，但它必须仍在。
  tools.push(tool('tool_search', 'x'.repeat(8000)));
  const bounded = ToolExposurePlanner.boundBySchemaBudget(tools, 3_000);
  assert.ok(bounded.visible.length > 0);
  assert.ok(bounded.visible.length < tools.length, '必须真的收窄（否则预算没接线）');
  assert.ok(
    bounded.visible.some((entry) => entry.name === 'tool_search'),
    '恒可见通道不得被预算挤掉',
  );
  assert.strictEqual(bounded.visible.length + bounded.deferred.length, tools.length, '不丢工具');
});

test('boundBySchemaBudget：budget<=0 表示不限制（零行为变更）', () => {
  const tools = [tool('a', 'x'.repeat(4000)), tool('b', 'y'.repeat(4000))];
  const bounded = ToolExposurePlanner.boundBySchemaBudget(tools, 0);
  assert.deepStrictEqual(bounded.visible, tools);
  assert.deepStrictEqual(bounded.deferred, []);
});
