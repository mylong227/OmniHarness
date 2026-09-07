// 发现引擎（P1 进化闭环"发现"段）单元测试。
// 覆盖：燧-1 组合生成、discoveryBudget 硬上限、预算耗尽返回空、不重复生成。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Skill } from '../../src/skill/skill.js';
import { composeByTwist } from '../../src/skill/skillComposer.js';
import { TwistDiscoveryEngine } from '../../src/evolution/discoveryEngine.js';
import type { Candidate } from '../../src/ports/evolution.js';

function baseSkill(name: string, topic: string): Skill {
  return {
    name,
    description: `${topic} 相关能力`,
    instructions: `执行 ${topic} 任务的具体步骤。`,
    tags: [topic],
  };
}

const pool = [
  baseSkill('a', '检索'),
  baseSkill('b', '推理'),
  baseSkill('c', '规划'),
  baseSkill('d', '摘要'),
];

test('生成组合候选：无序配对，来源标注 twist:', () => {
  const engine = new TwistDiscoveryEngine({
    skills: pool,
    compose: (a, b) => composeByTwist(a, b),
    maxCandidates: 10,
  });
  const got = engine.nextCandidates();
  assert.strictEqual(got.length, 6); // C(4,2) = 6
  for (const c of got) {
    assert.match(c.source, /^twist:/);
    assert.ok(c.skill.moire !== undefined, '组合技能应带 moire 元数据');
  }
});

test('discoveryBudget 硬上限：生成数不超过 maxCandidates', () => {
  const engine = new TwistDiscoveryEngine({
    skills: pool,
    compose: (a, b) => composeByTwist(a, b),
    maxCandidates: 3,
  });
  const all: Candidate[] = [];
  // 多轮调用直到耗尽
  for (let i = 0; i < 5; i++) {
    const batch = engine.nextCandidates();
    all.push(...batch);
    if (batch.length === 0) break;
  }
  assert.strictEqual(all.length, 3, '硬预算上限 3，不应生成更多');
  assert.strictEqual(engine.budgetUsed().generated, 3);
  assert.strictEqual(engine.budgetUsed().maxCandidates, 3);
  // 预算耗尽后返回空
  assert.deepStrictEqual(engine.nextCandidates(), []);
});

test('预算等于配对总数：恰好全生成', () => {
  const engine = new TwistDiscoveryEngine({
    skills: pool,
    compose: (a, b) => composeByTwist(a, b),
    maxCandidates: 6,
  });
  const got = engine.nextCandidates();
  assert.strictEqual(got.length, 6);
  assert.deepStrictEqual(engine.nextCandidates(), []);
});
