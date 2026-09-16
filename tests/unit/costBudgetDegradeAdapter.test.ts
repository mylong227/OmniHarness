/**
 * P5 自动降档：预算降级信号端口适配器单测。
 *
 * 验证 `CostBudgetDegradeAdapter` 正确桥接 `CostBudget.degradeSuggested`：
 *  - 无预算（undefined）⇒ 恒 false（fail-safe，默认部署零行为变更）；
 *  - 未越软阈值 ⇒ false；
 *  - 软超但未硬熔断 ⇒ true（这正是应降级的窗口）；
 *  - 已硬熔断 ⇒ false（degradeSuggested 在硬熔断后回落）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CostBudget } from '../../src/adapters/model/costBudget.js';
import { CostBudgetDegradeAdapter } from '../../src/adapters/model/costBudgetDegradeAdapter.js';

/** 构造一个可驱动软/硬阈值的预算实例（pricing 1 美元/token，便于精确触发）。 */
const makeBudget = (): CostBudget =>
  new CostBudget(
    10,
    new Map([['x', { inputPer1M: 1_000_000, outputPer1M: 3_000_000 }]]),
    { inputPer1M: 1.0, outputPer1M: 3.0 },
    undefined,
    false,
    0.5,
  );

test('P5 适配器：无预算（undefined）⇒ shouldDegrade 恒 false（fail-safe）', () => {
  const signal = new CostBudgetDegradeAdapter(undefined);
  assert.strictEqual(signal.shouldDegrade, false);
});

test('P5 适配器：未越软阈值 ⇒ false', () => {
  const budget = makeBudget();
  budget.record('x', { promptTokens: 2, completionTokens: 0, totalTokens: 2 }); // $2 < 软限 $5
  assert.strictEqual(budget.softExceeded, false);
  assert.strictEqual(new CostBudgetDegradeAdapter(budget).shouldDegrade, false);
});

test('P5 适配器：软超但未硬熔断 ⇒ true（应降级窗口）', () => {
  const budget = makeBudget();
  budget.record('x', { promptTokens: 6, completionTokens: 0, totalTokens: 6 }); // $6 ∈ [软$5, 硬$10)
  assert.strictEqual(budget.softExceeded, true);
  assert.strictEqual(budget.exceeded, false);
  assert.strictEqual(new CostBudgetDegradeAdapter(budget).shouldDegrade, true);
});

test('P5 适配器：已硬熔断 ⇒ false（degradeSuggested 回落）', () => {
  const budget = makeBudget();
  budget.record('x', { promptTokens: 11, completionTokens: 0, totalTokens: 11 }); // $11 ≥ 硬$10
  assert.strictEqual(budget.softExceeded, true);
  assert.strictEqual(budget.exceeded, true);
  assert.strictEqual(new CostBudgetDegradeAdapter(budget).shouldDegrade, false);
});
