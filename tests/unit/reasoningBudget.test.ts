import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ReasoningBudget } from '../../src/util/reasoningBudget.ts';

test('ReasoningBudget：未配置时简单任务 low、复杂任务 high', () => {
  assert.strictEqual(ReasoningBudget.executor(undefined, false, {}), 'low');
  assert.strictEqual(ReasoningBudget.executor(undefined, true, {}), 'high');
});

test('ReasoningBudget：用户显式配置对 executor 永远优先', () => {
  assert.strictEqual(ReasoningBudget.executor('max', false, {}), 'max');
  assert.strictEqual(ReasoningBudget.executor('none', true, {}), 'none');
});

test('ReasoningBudget：辅助角色压到 low，但不抬高用户显式的 none/minimal/low', () => {
  assert.strictEqual(ReasoningBudget.auxiliary('compactor', undefined, {}), 'low');
  assert.strictEqual(ReasoningBudget.auxiliary('reviewer', 'high', {}), 'low');
  assert.strictEqual(ReasoningBudget.auxiliary('memory', 'none', {}), 'none');
  assert.strictEqual(ReasoningBudget.auxiliary('guardian', 'minimal', {}), 'minimal');
});

test('ReasoningBudget：OMNI_REASONING_POLICY=off 逐字回到旧行为', () => {
  const env = { OMNI_REASONING_POLICY: 'off' };
  assert.strictEqual(ReasoningBudget.executor(undefined, true, env), undefined);
  assert.strictEqual(ReasoningBudget.executor('high', false, env), 'high');
  assert.strictEqual(ReasoningBudget.auxiliary('compactor', undefined, env), undefined);
  assert.strictEqual(ReasoningBudget.auxiliary('reviewer', 'high', env), 'high');
});

test('ReasoningBudget：策略大小写/空白不敏感', () => {
  assert.strictEqual(ReasoningBudget.enabled({ OMNI_REASONING_POLICY: ' OFF ' }), false);
  assert.strictEqual(ReasoningBudget.enabled({ OMNI_REASONING_POLICY: 'balanced' }), true);
  assert.strictEqual(ReasoningBudget.enabled({}), true);
});
