import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BudgetedModel } from '../../src/adapters/model/budgetedModel.ts';
import { CostBudget } from '../../src/adapters/model/costBudget.ts';
import { RoutePricing } from '../../src/adapters/model/routePricing.ts';
import { BudgetExceededError } from '../../src/ports/model/model.ts';
import type {
  ModelPort,
  ModelOutput,
  ModelRequest,
  StreamCallbacks,
} from '../../src/ports/model/model.ts';

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

test('无 usage 按本地估算记账并标记 estimated（2026-10-21）', async () => {
  const budget = new CostBudget(
    100,
    RoutePricing.mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }),
  );
  const inner = fakeModel({ text: 'hi' }, { n: 0 });
  const wrapped = new BudgetedModel(inner, budget);
  const out = await wrapped.generate({
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    tools: [],
  });
  assert.ok(budget.totalPromptTokens > 0, '缺 usage 也要有估算 token 进预算');
  assert.ok(budget.totalCostUsd > 0, '成本不能永远是 0（否则硬熔断永不触发）');
  assert.strictEqual(out.usage?.estimated, true, '估算用量必须显式标记，不得冒充精确值');
  assert.ok((out.usage?.promptTokens ?? 0) > 0);
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
