// T5.5（推理强度任务自适应）可证伪验收：
//   ① 难度分层正确：易 → low、中 → medium、难 → high（规则逐项可复算）；
//   ② 成本口径：混合 workload 下路由总预算 < 一刀切 high（易任务降档、难任务不变）；
//   ③ 难任务不受降档影响：hard 任务恒路由 high；
//   ④ 确定性：同任务重复路由 20 次恒同档位。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeReasoning,
  taskDifficultyScore,
  budgetCompare,
  EFFORT_COST,
} from '../../src/eval/reasoningRouter.js';

const EASY = '把这段话翻译成英文。';
const MEDIUM = `重构这个函数：必须保持签名不变，同时把循环改成查表。\n先解析输入，再逐分支替换，然后跑回归。`;
const HARD = `先给出方案：\n\`\`\`ts\nexport function f(x: number): number { return x; }\n\`\`\`\n必须兼容至少 3 种调用点，同时不得引入新依赖，并且至少覆盖两条错误路径；第一步建模，第二步证明边界。`;

test('① 难度分层：易 low、中 medium、难 high', () => {
  assert.strictEqual(routeReasoning(EASY), 'low');
  assert.strictEqual(routeReasoning(MEDIUM), 'medium');
  assert.strictEqual(routeReasoning(HARD), 'high');
});

test('①b 评分逐项可复算：代码块 +2、多步 +2、长度 +1', () => {
  assert.strictEqual(taskDifficultyScore('短任务'), 0);
  assert.strictEqual(taskDifficultyScore(`看代码：\n\`\`\`js\nx()\n\`\`\``), 2);
  assert.strictEqual(taskDifficultyScore('第一步做这个'), 2);
  assert.strictEqual(taskDifficultyScore(`${'x'.repeat(501)}`), 1);
});

test('② 成本口径：混合 workload 路由总预算严格低于一刀切 high', () => {
  const tasks = [EASY, EASY, EASY, MEDIUM, HARD];
  const { routedTotal, fixedTotal, delta } = budgetCompare(tasks);
  assert.strictEqual(
    routedTotal,
    EFFORT_COST.low * 3 + EFFORT_COST.medium + EFFORT_COST.high,
    '路由总额 = 易×low + 中×medium + 难×high',
  );
  assert.strictEqual(fixedTotal, tasks.length * EFFORT_COST.high);
  assert.ok(delta < 0, `路由必须更省（delta=${delta}）`);
});

test('③ 难任务恒 high：不因其他任务易而降档', () => {
  for (let i = 0; i < 10; i++) assert.strictEqual(routeReasoning(HARD), 'high');
});

test('④ 确定性：同任务重复路由 20 次恒同档位', () => {
  for (const t of [EASY, MEDIUM, HARD]) {
    const first = routeReasoning(t);
    for (let i = 0; i < 19; i++)
      assert.strictEqual(routeReasoning(t), first, `「${t.slice(0, 12)}…」必须恒同档位`);
  }
});
