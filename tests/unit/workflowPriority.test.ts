/**
 * 工作流关键路径优先级判据：底位级计算、并列稳定、长链优先。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WorkflowPriority } from '../../src/autonomy/workflowPriority.ts';
import type { WorkflowStep } from '../../src/autonomy/workflowTypes.ts';

/** 造步骤。 */
function step(id: string, dependsOn?: string[]): WorkflowStep {
  return { id, prompt: id, ...(dependsOn !== undefined ? { dependsOn } : {}) };
}

test('① 菱形：A→B/C→D 的底位级', () => {
  const rank = WorkflowPriority.rank([
    step('A'),
    step('B', ['A']),
    step('C', ['A']),
    step('D', ['B', 'C']),
  ]);
  assert.strictEqual(rank.get('A'), 3);
  assert.strictEqual(rank.get('B'), 2);
  assert.strictEqual(rank.get('C'), 2);
  assert.strictEqual(rank.get('D'), 1);
});

test('② 长链优先：A→B→D 与独立 C，按底位级排序', () => {
  const ids = ['A', 'C', 'B', 'D'];
  const rank = WorkflowPriority.rank([step('A'), step('B', ['A']), step('C'), step('D', ['B'])]);
  assert.deepStrictEqual(WorkflowPriority.order(ids, rank), ['A', 'B', 'C', 'D']);
});

test('③ 并列稳定：同底位级保持声明顺序', () => {
  const ids = ['C', 'A', 'B'];
  const rank = WorkflowPriority.rank([step('A'), step('B'), step('C')]);
  assert.deepStrictEqual(WorkflowPriority.order(ids, rank), ['C', 'A', 'B']);
});

test('④ 单链与空图边界', () => {
  assert.deepStrictEqual(WorkflowPriority.order([], new Map()), []);
  const rank = WorkflowPriority.rank([step('A'), step('B', ['A']), step('C', ['B'])]);
  assert.strictEqual(rank.get('A'), 3);
  assert.strictEqual(rank.get('C'), 1);
});
