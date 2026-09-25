import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetedModel } from '../../src/adapters/model/budgetedModel.js';
import { CostBudget } from '../../src/adapters/model/costBudget.js';
import { RoutePricing } from '../../src/adapters/model/routePricing.js';
import { BudgetExceededError } from '../../src/ports/model/model.js';
import type {
  ModelPort,
  ModelOutput,
  ModelRequest,
  StreamCallbacks,
} from '../../src/ports/model/model.js';

function fakeModel(returns: ModelOutput, calls: { n: number }): ModelPort {
  return {
    name: 'x',
    async generate(_req: ModelRequest): Promise<ModelOutput> {
      calls.n += 1;
      return returns;
    },
  };
}

test('记账并透传 usage', async () => {
  const budget = new CostBudget(
    100,
    RoutePricing.mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }),
  );
  const calls = { n: 0 };
  const inner = fakeModel(
    {
      text: 'hi',
      usage: { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 },
    },
    calls,
  );
  const wrapped = new BudgetedModel(inner, budget);
  const out = await wrapped.generate({ messages: [], tools: [] });
  assert.strictEqual(calls.n, 1);
  assert.strictEqual(out.usage?.promptTokens, 1_000_000);
  assert.strictEqual(Number(budget.totalCostUsd.toFixed(4)), 1.5);
});

test('超预算后阻断且不再调用模型（fail-closed）', async () => {
  const budget = new CostBudget(
    1,
    RoutePricing.mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }),
  );
  const calls = { n: 0 };
  const inner = fakeModel(
    { text: 'hi', usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 } },
    calls,
  );
  const wrapped = new BudgetedModel(inner, budget);
  await wrapped.generate({ messages: [], tools: [] }); // cost 1.0 -> 熔断
  assert.strictEqual(calls.n, 1);
  await assert.rejects(() => wrapped.generate({ messages: [], tools: [] }), BudgetExceededError);
  assert.strictEqual(calls.n, 1); // 第二次被阻断，未发起真实调用
});

test('无 usage 不记账（绝不臆造成本）', async () => {
  const budget = new CostBudget(
    100,
    RoutePricing.mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }),
  );
  const inner = fakeModel({ text: 'hi' }, { n: 0 });
  const wrapped = new BudgetedModel(inner, budget);
  await wrapped.generate({ messages: [], tools: [] });
  assert.strictEqual(budget.totalPromptTokens, 0);
  assert.strictEqual(budget.totalCostUsd, 0);
});

test('stream 缺失时回退 generate 并记账', async () => {
  const budget = new CostBudget(
    100,
    RoutePricing.mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }),
  );
  const calls = { n: 0 };
  const inner = fakeModel(
    { text: 'hi', usage: { promptTokens: 2_000_000, completionTokens: 0, totalTokens: 2_000_000 } },
    calls,
  );
  const wrapped = new BudgetedModel(inner, budget);
  const out = await wrapped.stream({ messages: [], tools: [] }, {
    onText: () => {},
  } as unknown as StreamCallbacks);
  assert.strictEqual(calls.n, 1);
  assert.strictEqual(budget.totalCostUsd, 2);
  assert.ok(out.text === 'hi');
});
