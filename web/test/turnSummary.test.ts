// 回合结果汇总模型（纯函数）契约测试：turn_diff 与写类工具回执的合并、去重、分组与排序。
//
// 直跑：node --test web/test/turnSummary.test.ts（无需浏览器）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ThreadEvent } from '../src/types/models.ts';

const { buildTurnSummary } = await import('../src/ui/models/TurnSummary.ts');

/** 造事件的短手（`at` 为毫秒时间戳，缺省 0）。 */
function ev(
  id: string,
  type: ThreadEvent['type'],
  payload: Record<string, unknown>,
  at = 0,
): ThreadEvent {
  return { id, type, timestamp: at, payload };
}

const DIFF = [
  '--- a/docs/plan.md',
  '+++ b/docs/plan.md',
  '@@ -0,0 +1,2 @@',
  '+# 计划',
  '+收口。',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
].join('\n');

test('turn_diff 按 created 分组、增删统计正确', () => {
  const summary = buildTurnSummary([
    ev('u1', 'user', { content: '做点事' }),
    ev('d1', 'turn_diff', { diff: DIFF }),
  ]);
  assert.deepEqual(
    summary.files.map((f) => [f.path, f.group, f.added, f.deleted]),
    [
      ['docs/plan.md', 'created', 2, 0],
      ['src/app.ts', 'modified', 2, 1],
    ],
  );
  assert.strictEqual(summary.createdCount, 1);
  assert.strictEqual(summary.modifiedCount, 1);
  assert.strictEqual(summary.added, 4);
  assert.strictEqual(summary.deleted, 1);
});

test('diff 覆盖不到的产物按工具语义补位（草图 → 生成），同路径去重', () => {
  const summary = buildTurnSummary([
    ev('c1', 'tool_call', { callId: 'c1', name: 'write_file', args: { path: 'docs/plan.md' } }),
    ev('r1', 'tool_result', { callId: 'c1', ok: true, output: '已写入 docs/plan.md' }),
    ev('c2', 'tool_call', { callId: 'c2', name: 'sketch_write', args: {} }),
    ev('r2', 'tool_result', { callId: 'c2', ok: true, output: '草图已保存: web/archive/a.png（1280×900）' }),
    ev('d1', 'turn_diff', { diff: DIFF }),
  ]);
  assert.deepEqual(
    summary.files.map((f) => [f.path, f.group, f.kind]),
    [
      ['docs/plan.md', 'created', 'file'],
      ['web/archive/a.png', 'created', 'sketch'],
      ['src/app.ts', 'modified', 'patch'],
    ],
  );
  // 同一路径只出现一次（write_file 的产物不会在 diff 行之外再补一行）。
  assert.strictEqual(summary.files.filter((f) => f.path === 'docs/plan.md').length, 1);
});

test('失败的工具回执不登记产物；apply_patch 无 diff 时归「修改」', () => {
  const summary = buildTurnSummary([
    ev('c1', 'tool_call', { callId: 'c1', name: 'write_file', args: { path: 'a.ts' } }),
    ev('r1', 'tool_result', { callId: 'c1', ok: false, error: '磁盘只读' }),
    ev('c2', 'tool_call', { callId: 'c2', name: 'apply_patch', args: { path: 'b.ts' } }),
    ev('r2', 'tool_result', { callId: 'c2', ok: true, text: '补丁已应用（旧形状回执）' }),
  ]);
  assert.deepEqual(
    summary.files.map((f) => [f.path, f.group, f.added, f.deleted]),
    [['b.ts', 'modified', 0, 0]],
  );
});

test('空事件 / 无 diff 无产物 → 空清单（不渲染结果卡）', () => {
  const summary = buildTurnSummary([ev('u1', 'user', { content: '只聊天' })]);
  assert.deepEqual(summary.files, []);
  assert.strictEqual(summary.createdCount, 0);
  assert.strictEqual(summary.modifiedCount, 0);
});

test('本轮耗时 = 首尾事件时间戳之差（含思考与工具执行）', () => {
  const base = 1_700_000_000_000;
  const summary = buildTurnSummary([
    ev('u1', 'user', { content: '做点事' }, base),
    ev('c1', 'tool_call', { callId: 'c1', name: 'shell', args: { command: 'ls' } }, base + 5_000),
    ev('r1', 'tool_result', { callId: 'c1', ok: true, output: 'a.ts' }, base + 12_000),
    ev('a1', 'assistant', { content: '完成' }, base + 40_000),
    ev('d1', 'turn_diff', { diff: DIFF }, base + 65_000),
  ]);
  assert.strictEqual(summary.durationMs, 65_000);
});

test('时间戳缺失 / 全 0 时耗时为 0（卡片不显示）', () => {
  const summary = buildTurnSummary([
    ev('u1', 'user', { content: 'a' }),
    ev('d1', 'turn_diff', { diff: DIFF }),
  ]);
  assert.strictEqual(summary.durationMs, 0);
});
