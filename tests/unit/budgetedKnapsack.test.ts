/**
 * 0/1 背包选择判据：精确最优、贪心反例、至少一项、规模回退。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BudgetedKnapsack } from '../../src/util/budgetedKnapsack.ts';

test('① 贪心反例：A(15,10)+B(6,6)+C(5,5) 预算 11 ⇒ 选 B+C（价值 11）', () => {
  const result = BudgetedKnapsack.select(
    [
      { id: 'A', weight: 15, value: 10 },
      { id: 'B', weight: 6, value: 6 },
      { id: 'C', weight: 5, value: 5 },
    ],
    11,
  );
  assert.deepStrictEqual(result.indices, [1, 2]);
  assert.strictEqual(result.value, 11);
  assert.strictEqual(result.weight, 11);
});

test('② 0/1 约束：同一项不能重复选；预算不足时返回空', () => {
  const result = BudgetedKnapsack.select([{ id: 'x', weight: 6, value: 10 }], 10);
  assert.deepStrictEqual(result.indices, [0]);
  const none = BudgetedKnapsack.select([{ id: 'x', weight: 6, value: 10 }], 0);
  assert.deepStrictEqual(none.indices, []);
  assert.strictEqual(none.value, 0);
});

test('③ atLeastOne：全部超预算时保留价值最高的一项', () => {
  const result = BudgetedKnapsack.select(
    [
      { id: 'big', weight: 100, value: 2 },
      { id: 'huge', weight: 200, value: 9 },
    ],
    10,
    true,
  );
  assert.deepStrictEqual(result.indices, [1]);
  assert.strictEqual(result.value, 9);
});

test('④ 确定性：价值并列时取先出现项，不随输入顺序抖动', () => {
  const a = BudgetedKnapsack.select(
    [
      { id: 'a', weight: 1, value: 1 },
      { id: 'b', weight: 1, value: 1 },
    ],
    1,
  );
  const b = BudgetedKnapsack.select(
    [
      { id: 'a', weight: 1, value: 1 },
      { id: 'b', weight: 1, value: 1 },
    ],
    1,
  );
  assert.deepStrictEqual(a.indices, b.indices);
  assert.deepStrictEqual(a.indices, [0]);
});

test('⑤ 规模回退：超大预算走贪心且仍满足重量约束', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: `i${String(i)}`,
    weight: 1000 + i,
    value: 1 + (i % 7),
  }));
  const result = BudgetedKnapsack.select(items, 50_000);
  assert.ok(result.weight <= 50_000);
  assert.ok(result.value > 0);
});
