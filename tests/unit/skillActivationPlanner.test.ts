/**
 * 多 Skill 激活规划：重复文本去重、字符预算、tag 冲突观测。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SkillActivationPlanner } from '../../src/skill/skillActivationPlanner.ts';
import type { Skill } from '../../src/ports/skill/skill.ts';

function skill(name: string, tags: readonly string[], instructions = 'do it'): Skill {
  return { name, description: name, instructions, tags };
}

test('SkillActivationPlanner：同一渲染文本只保留一份', () => {
  const planner = new SkillActivationPlanner();
  const a = skill('a', ['x']);
  const b = skill('b', ['y']);
  const plan = planner.plan([
    { skill: a, rendered: 'same text', relevance: 10 },
    { skill: b, rendered: 'same   text', relevance: 5 },
  ]);
  assert.deepStrictEqual(
    plan.kept.map((entry) => entry.skill.name),
    ['a'],
  );
  assert.strictEqual(plan.duplicates, 1);
  assert.strictEqual(plan.dropped[0]?.skill.name, 'b');
});

test('SkillActivationPlanner：超出字符预算丢弃低相关项，但至少保留一条', () => {
  const planner = new SkillActivationPlanner(20);
  const plan = planner.plan([
    { skill: skill('high', ['x']), rendered: 'h'.repeat(15), relevance: 10 },
    { skill: skill('low', ['y']), rendered: 'l'.repeat(15), relevance: 1 },
  ]);
  assert.deepStrictEqual(
    plan.kept.map((entry) => entry.skill.name),
    ['high'],
  );
  assert.strictEqual(plan.dropped.length, 1);
  const only = planner.plan([
    { skill: skill('only', ['z']), rendered: 'z'.repeat(100), relevance: 1 },
  ]);
  assert.strictEqual(only.kept.length, 1, '单条超预算也必须保留（避免能力归零）');
});

test('SkillActivationPlanner：tag Jaccard ≥0.8 记为冲突且不误删', () => {
  const planner = new SkillActivationPlanner();
  const plan = planner.plan([
    { skill: skill('a', ['web', 'browser', 'ui']), rendered: 'A', relevance: 2 },
    { skill: skill('b', ['web', 'browser', 'ui']), rendered: 'B', relevance: 1 },
  ]);
  assert.strictEqual(plan.kept.length, 2, '冲突只观测，不擅自删技能');
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.conflicts[0]?.overlap, 1);
});

test('SkillActivationPlanner：无 tag 不误报冲突', () => {
  const planner = new SkillActivationPlanner();
  const plan = planner.plan([
    { skill: skill('a', []), rendered: 'A', relevance: 2 },
    { skill: skill('b', []), rendered: 'B', relevance: 1 },
  ]);
  assert.strictEqual(plan.conflicts.length, 0);
});

test('SkillActivationPlanner：exclusive 资源冲突保留高相关者并记录', () => {
  const planner = new SkillActivationPlanner();
  const high = { ...skill('high', ['web']), resources: ['browser'], exclusive: true };
  const low = { ...skill('low', ['web']), resources: ['browser'], exclusive: true };
  const plan = planner.plan([
    { skill: high, rendered: 'high instructions', relevance: 10 },
    { skill: low, rendered: 'low instructions', relevance: 1 },
  ]);
  assert.deepStrictEqual(
    plan.kept.map((entry) => entry.skill.name),
    ['high'],
  );
  assert.deepStrictEqual(
    plan.dropped.map((entry) => entry.skill.name),
    ['low'],
  );
  assert.strictEqual(plan.conflicts[0]?.resources[0], 'browser');
});

test('SkillActivationPlanner：非 exclusive 共享资源只观测不删除', () => {
  const planner = new SkillActivationPlanner();
  const a = { ...skill('a', ['x']), resources: ['port:5173'] };
  const b = { ...skill('b', ['y']), resources: ['port:5173'] };
  const plan = planner.plan([
    { skill: a, rendered: 'A', relevance: 2 },
    { skill: b, rendered: 'B', relevance: 1 },
  ]);
  assert.strictEqual(plan.kept.length, 2);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.deepStrictEqual(plan.conflicts[0]?.resources, ['port:5173']);
});
