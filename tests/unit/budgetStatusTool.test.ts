import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetStatusTool } from '../../src/adapters/tool/budgetStatusTool.js';
import { CostBudget } from '../../src/adapters/model/costBudget.js';
import { mergeRoutePricing } from '../../src/adapters/model/routePricing.js';

test('budget_status 返回当前快照', async () => {
  const budget = new CostBudget(10, mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }));
  budget.record('x', {
    promptTokens: 2_000_000,
    completionTokens: 1_000_000,
    totalTokens: 3_000_000,
  }); // cost 3
  const tool = new BudgetStatusTool(budget);
  const res = await tool.handle(
    { id: 'c1', name: 'budget_status', arguments: {} },
    { sessionId: 's', workspaceRoot: '.' },
  );
  assert.strictEqual(res.ok, true);
  const parsed = JSON.parse(res.output ?? '{}');
  assert.strictEqual(parsed.limitUsd, 10);
  assert.strictEqual(parsed.spentUsd, 3);
  assert.strictEqual(parsed.remainingUsd, 7);
  assert.strictEqual(parsed.totalPromptTokens, 2_000_000);
  assert.strictEqual(parsed.totalCompletionTokens, 1_000_000);
  assert.strictEqual(parsed.exceeded, false);
});

test('budget_status 反映已熔断', async () => {
  const budget = new CostBudget(1, mergeRoutePricing({ x: { inputPer1M: 1, outputPer1M: 1 } }));
  budget.record('x', { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
  const tool = new BudgetStatusTool(budget);
  const res = await tool.handle(
    { id: 'c2', name: 'budget_status', arguments: {} },
    { sessionId: 's', workspaceRoot: '.' },
  );
  const parsed = JSON.parse(res.output ?? '{}');
  assert.strictEqual(parsed.exceeded, true);
  assert.strictEqual(parsed.remainingUsd, 0);
});
