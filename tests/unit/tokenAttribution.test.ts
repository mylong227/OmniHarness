/**
 * P5 per-tool token 归因单测（零依赖；直接构造事件流，不触网、不跑运行时）。
 *
 * 覆盖：单工具/多工具批次归因、`<initial>` 桶、多轮分段、无 usage 如实计数、
 * 重复工具名去重、异常 payload 忽略、占比与排序、总量守恒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenAttribution, INITIAL_BUCKET } from '../../src/observability/tokenAttribution.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * 构造一条事件。
 * @param type 事件类型。
 * @param payload 事件负载。
 * @returns 结构完整的会话事件。
 */
const ev = (type: SessionEvent['type'], payload: unknown): SessionEvent => ({
  id: `e-${type}-${Math.random().toString(36).slice(2, 8)}`,
  type,
  sessionId: 's1',
  timestamp: '2026-09-16T00:00:00.000Z',
  payload,
});

/**
 * 构造一条 `tool_call` 事件。
 * @param name 工具名。
 * @returns 会话事件。
 */
const call = (name: string): SessionEvent => ev('tool_call', { callId: 'c', name, args: {} });

/**
 * 构造一条 `model` 事件。
 * @param promptTokens 输入 token。
 * @param completionTokens 输出 token。
 * @param cachedPromptTokens 缓存命中 token（可选）。
 * @returns 会话事件。
 */
const model = (
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens?: number,
): SessionEvent =>
  ev('model', {
    model: 'x',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    },
  });

test('单工具批次：整批 usage 归该工具', () => {
  const report = TokenAttribution.fromEvents([model(100, 50), call('read_file'), model(300, 100)]);
  const read = report.buckets.find((b) => b.tool === 'read_file');
  const initial = report.buckets.find((b) => b.tool === INITIAL_BUCKET);
  assert.ok(read !== undefined);
  assert.ok(initial !== undefined);
  assert.strictEqual(read.totalTokens, 400); // 300 + 100
  assert.strictEqual(read.toolCalls, 1);
  assert.strictEqual(initial.totalTokens, 150); // 100 + 50
  assert.strictEqual(report.modelCallsWithUsage, 2);
});

test('多工具批次：usage 在桶间均分，各桶之和 == 总量', () => {
  const report = TokenAttribution.fromEvents([call('read_file'), call('shell'), model(400, 200)]);
  const read = report.buckets.find((b) => b.tool === 'read_file');
  const shell = report.buckets.find((b) => b.tool === 'shell');
  assert.strictEqual(read?.promptTokens, 200);
  assert.strictEqual(shell?.promptTokens, 200);
  assert.strictEqual(read?.completionTokens, 100);
  assert.strictEqual(shell?.completionTokens, 100);
  assert.strictEqual(report.totalTokens, 600);
});

test('无前驱工具调用 → <initial> 桶', () => {
  const report = TokenAttribution.fromEvents([model(10, 20)]);
  assert.strictEqual(report.buckets.length, 1);
  assert.strictEqual(report.buckets[0]?.tool, INITIAL_BUCKET);
  assert.strictEqual(report.buckets[0]?.totalTokens, 30);
});

test('多轮分段：每段独立归因，不越界', () => {
  const report = TokenAttribution.fromEvents([
    model(10, 0), // initial
    call('a'),
    model(100, 0), // a
    call('b'),
    model(1000, 0), // b
  ]);
  const byTool = new Map(report.buckets.map((b) => [b.tool, b.totalTokens]));
  assert.strictEqual(byTool.get(INITIAL_BUCKET), 10);
  assert.strictEqual(byTool.get('a'), 100);
  assert.strictEqual(byTool.get('b'), 1000);
});

test('无 usage 的 model 事件：如实计数，且批次被消耗（不串到下一轮）', () => {
  const report = TokenAttribution.fromEvents([
    call('a'),
    ev('model', { model: 'x' }), // 无 usage
    call('b'),
    model(50, 0),
  ]);
  assert.strictEqual(report.modelCallsWithUsage, 1);
  assert.strictEqual(report.modelCallsWithoutUsage, 1);
  const a = report.buckets.find((b) => b.tool === 'a');
  const b = report.buckets.find((b) => b.tool === 'b');
  assert.strictEqual(b?.totalTokens, 50, 'b 独占本轮 usage，不被无 usage 轮的前驱工具分走');
  assert.strictEqual(a?.toolCalls, 1, 'a 被调用过，仍计入调用次数');
  assert.strictEqual(a?.totalTokens, 0, 'a 那轮无 usage ⇒ 其 token 不可归因，记 0 而非摊派');
});

test('同批重复工具名：调用次数分别计，token 只分一份', () => {
  const report = TokenAttribution.fromEvents([call('a'), call('a'), model(100, 0)]);
  const a = report.buckets.find((b) => b.tool === 'a');
  assert.strictEqual(a?.toolCalls, 2);
  assert.strictEqual(a?.promptTokens, 100, '去重后只分一份，避免重复计数');
});

test('异常 payload：忽略而非臆造或抛错', () => {
  const report = TokenAttribution.fromEvents([
    ev('tool_call', null),
    ev('tool_call', { name: 42 }),
    ev('model', 'not-an-object'),
    ev('model', { usage: { promptTokens: 'x', completionTokens: 1 } }),
    ev('user', { content: 'hi' }),
    model(7, 3),
  ]);
  assert.strictEqual(report.modelCallsWithUsage, 1);
  assert.strictEqual(report.modelCallsWithoutUsage, 2, '形状非法的 usage 记「无」而非 0');
  assert.strictEqual(report.buckets.length, 1);
  assert.strictEqual(report.buckets[0]?.tool, INITIAL_BUCKET);
  assert.strictEqual(report.buckets[0]?.totalTokens, 10);
});

test('占比与降序：share 之和 ≈ 1，按 token 降序', () => {
  const report = TokenAttribution.fromEvents([
    call('small'),
    model(10, 0),
    call('big'),
    model(990, 0),
  ]);
  assert.strictEqual(report.buckets[0]?.tool, 'big');
  assert.strictEqual(report.buckets[1]?.tool, 'small');
  const sum = report.buckets.reduce((acc, b) => acc + b.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs((report.buckets[0]?.share ?? 0) - 0.99) < 1e-9);
});

test('缓存命中量随桶分摊并汇总', () => {
  const report = TokenAttribution.fromEvents([model(100, 0, 80)]);
  assert.strictEqual(report.totalCachedPromptTokens, 80);
  assert.strictEqual(report.buckets[0]?.cachedPromptTokens, 80);
});

test('尾部无后继 model 的工具调用：计入调用数、token 为 0', () => {
  const report = TokenAttribution.fromEvents([model(5, 0), call('orphan')]);
  const orphan = report.buckets.find((b) => b.tool === 'orphan');
  assert.strictEqual(orphan?.toolCalls, 1);
  assert.strictEqual(orphan?.totalTokens, 0);
  assert.strictEqual(report.totalTokens, 5);
});
