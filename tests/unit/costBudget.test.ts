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

test('P5 缓存命中按缓存价折抵（并量化省下金额）', () => {
  const budget = new CostBudget(
    100,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0, cachedInputPer1M: 0.1 } }),
  );
  budget.record('x', {
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    cachedPromptTokens: 1_000_000, // 全部命中
  });
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 0.1); // 1M × $0.1
  assert.strictEqual(budget.totalCachedPromptTokens, 1_000_000);
  assert.strictEqual(Number(budget.totalSavedUsd.toFixed(4)), 0.9); // 1.0 - 0.1
});

test('P5 部分命中：未命中部分仍按输入价', () => {
  const budget = new CostBudget(
    100,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0, cachedInputPer1M: 0.2 } }),
  );
  budget.record('x', {
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    cachedPromptTokens: 400_000,
  });
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 0.68); // 0.6×1 + 0.4×0.2
  assert.strictEqual(Number(budget.totalSavedUsd.toFixed(4)), 0.32); // 0.4×(1-0.2)
});

test('P5 cachedPromptTokens 缺值 = 未知：不打折（保守记成本）', () => {
  const budget = new CostBudget(
    100,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0, cachedInputPer1M: 0.1 } }),
  );
  budget.record('x', { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 1.0);
  assert.strictEqual(budget.totalCachedPromptTokens, 0);
  assert.strictEqual(budget.totalSavedUsd, 0);
});

test('P5 无缓存价配置的模型：命中亦不打折', () => {
  const budget = new CostBudget(100, mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0 } }));
  budget.record('x', {
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    cachedPromptTokens: 1_000_000,
  });
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 1.0);
  assert.strictEqual(budget.totalSavedUsd, 0);
});

test('P5 越界命中量被截断到 promptTokens（防端点脏值）', () => {
  const budget = new CostBudget(
    100,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0, cachedInputPer1M: 0.1 } }),
  );
  budget.record('x', {
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    cachedPromptTokens: 5_000_000, // 端点脏值
  });
  assert.strictEqual(budget.totalCachedPromptTokens, 1_000_000);
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 0.1);
});

test('P5 软阈值置位一次并回调（degradeSuggested 在熔断前为真）', () => {
  const seen: string[] = [];
  const budget = new CostBudget(
    10,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0 } }),
    DEFAULT_FALLBACK_PRICE,
    undefined,
    true,
    0.5, // 软阈值 = $5
    (snap) => seen.push(`soft:${snap.spentUsd}`),
  );
  budget.record('x', { promptTokens: 4_000_000, completionTokens: 0, totalTokens: 4_000_000 }); // $4
  assert.strictEqual(budget.softExceeded, false);
  assert.strictEqual(budget.degradeSuggested, false);
  budget.record('x', { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }); // 累计 $5
  assert.strictEqual(budget.softExceeded, true);
  assert.strictEqual(budget.degradeSuggested, true);
  assert.strictEqual(budget.exceeded, false);
  assert.strictEqual(seen.length, 1);
  budget.record('x', { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }); // $6
  assert.strictEqual(seen.length, 1, '软阈值回调只触发一次');
});

test('P5 硬熔断后 degradeSuggested 归假（已无需降级，只待阻断）', () => {
  const budget = new CostBudget(
    10,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0 } }),
    DEFAULT_FALLBACK_PRICE,
    undefined,
    true,
    0.5,
  );
  budget.record('x', { promptTokens: 10_000_000, completionTokens: 0, totalTokens: 10_000_000 });
  assert.strictEqual(budget.exceeded, true);
  assert.strictEqual(budget.softExceeded, true);
  assert.strictEqual(budget.degradeSuggested, false);
});

test('P5 非法 softRatio 回落默认 0.8', () => {
  const bad = new CostBudget(
    10,
    mergeRoutePricing(),
    DEFAULT_FALLBACK_PRICE,
    undefined,
    true,
    Number.NaN,
  );
  assert.strictEqual(bad.softRatio, 0.8);
  const tooBig = new CostBudget(
    10,
    mergeRoutePricing(),
    DEFAULT_FALLBACK_PRICE,
    undefined,
    true,
    2,
  );
  assert.strictEqual(tooBig.softRatio, 0.8);
  const ok = new CostBudget(10, mergeRoutePricing(), DEFAULT_FALLBACK_PRICE, undefined, true, 0.25);
  assert.strictEqual(ok.softRatio, 0.25);
  assert.strictEqual(ok.softLimitUsd, 2.5);
});

test('P5 snapshot 含缓存折抵与软硬阈值字段', () => {
  const budget = new CostBudget(
    10,
    mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 0, cachedInputPer1M: 0.1 } }),
    DEFAULT_FALLBACK_PRICE,
    undefined,
    true,
    0.5,
  );
  budget.record('x', {
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    cachedPromptTokens: 1_000_000,
  });
  const snap = budget.snapshot();
  assert.strictEqual(snap.cachedPromptTokens, 1_000_000);
  assert.strictEqual(Number(snap.savedUsd.toFixed(4)), 0.9);
  assert.strictEqual(snap.softLimitUsd, 5);
  assert.strictEqual(snap.softExceeded, false); // 花费 0.1 < 5
  assert.strictEqual(snap.degradeSuggested, false);
});
