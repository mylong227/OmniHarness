import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CostBudget } from '../../src/adapters/model/costBudget.js';
import {
  mergeRoutePricing,
  DEFAULT_ROUTE_PRICING,
  DEFAULT_FALLBACK_PRICE,
} from '../../src/adapters/model/routePricing.js';
import { BudgetExceededError } from '../../src/ports/model/model.js';

test('priceFor: 精确 / 最长前缀 / 兜底', () => {
  const pricing = mergeRoutePricing();
  const budget = new CostBudget(100, pricing);
  assert.strictEqual(
    budget.priceFor('deepseek-chat').inputPer1M,
    DEFAULT_ROUTE_PRICING['deepseek-chat']!.inputPer1M,
  );
  assert.strictEqual(
    budget.priceFor('gpt-4o-2024-08-06').inputPer1M,
    DEFAULT_ROUTE_PRICING['gpt-4o']!.inputPer1M,
  );
  assert.strictEqual(budget.priceFor('totally-unknown-model').inputPer1M, 1.0); // 兜低价
});

test('record 累计 token 与成本（按定价）', () => {
  const budget = new CostBudget(100, mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }));
  budget.record('x', {
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    totalTokens: 2_000_000,
  });
  assert.strictEqual(budget.totalPromptTokens, 1_000_000);
  assert.strictEqual(budget.totalCompletionTokens, 1_000_000);
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 2.0); // 1 + 1
  assert.strictEqual(budget.remainingUsd, 98);
  assert.strictEqual(budget.exceeded, false);
});

test('越硬预算即熔断并阻断', () => {
  const budget = new CostBudget(1, mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }));
  budget.record('x', { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }); // cost 1.0 >= 1
  assert.strictEqual(budget.exceeded, true);
  assert.throws(() => budget.ensureWithin('x'), BudgetExceededError);
});

test('软预算（blocking=false）只标记不阻断', () => {
  const budget = new CostBudget(1, mergeRoutePricing(), DEFAULT_FALLBACK_PRICE, undefined, false);
  budget.record('deepseek-chat', {
    promptTokens: 10_000_000,
    completionTokens: 0,
    totalTokens: 10_000_000,
  });
  assert.strictEqual(budget.exceeded, true);
  assert.doesNotThrow(() => budget.ensureWithin('deepseek-chat'));
});

test('snapshot 反映全部计数', () => {
  const budget = new CostBudget(50, mergeRoutePricing({ x: { inputPer1M: 2, outputPer1M: 0 } }));
  budget.record('x', { promptTokens: 5_000_000, completionTokens: 0, totalTokens: 5_000_000 }); // cost 10
  const snap = budget.snapshot();
  assert.strictEqual(snap.limitUsd, 50);
  assert.strictEqual(Number(snap.spentUsd.toFixed(4)), 10);
  assert.strictEqual(snap.remainingUsd, 40);
  assert.strictEqual(snap.totalPromptTokens, 5_000_000);
  assert.strictEqual(snap.exceeded, false);
});
