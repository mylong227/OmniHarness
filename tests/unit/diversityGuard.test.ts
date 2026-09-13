// T5.2（多样性保留 · 抗 Echo Trap）可证伪验收：
//   ① Echo 副本超配额被拒：同内容（改名）技能只保留 maxDuplicates 份；
//   ② 同 corpus 连续 N 轮：适应度序列单调改善且去重率不塌缩（collapsed=false、ratio ≥ 下限）；
//   ③ Echo 种群判塌缩：全同内容 → collapsed=true；
//   ④ 确定性：同候选序列重复 20 次准入结果完全一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiversityGuard, skillFingerprint } from '../../src/evolution/diversityGuard.js';
import type { Skill } from '../../src/skill/skill.js';

function skill(name: string, instructions: string, tags?: readonly string[]): Skill {
  return { name, instructions, ...(tags ? { tags } : {}) } as Skill;
}

test('① 改名不算新意：同指纹超配额拒收（保首份即保最优）', () => {
  const g = new DiversityGuard({ maxDuplicates: 2 });
  const pop = [
    skill('v1', '把循环改成查表，注意越界。'),
    skill('v2-better-name', '把循环改成查表，注意越界。'), // 同指纹（改名）
    skill('v3-copy', '把循环改成查表，注意越界。'), // 第三份 → 拒
    skill('v4-new', '用前缀和替代区间扫描，注意负数。'), // 真新意 → 收
  ];
  const r = g.admit(pop);
  assert.deepStrictEqual(
    r.admitted.map((s) => s.name),
    ['v1', 'v2-better-name', 'v4-new'],
  );
  assert.deepStrictEqual(
    r.rejected.map((s) => s.name),
    ['v3-copy'],
  );
  assert.strictEqual(r.distinctRatio, 2 / 3);
  assert.strictEqual(r.collapsed, false);
});

test('①b 指纹规范空白与大小写；标签集参与指纹且与顺序无关', () => {
  const a = skill('a', 'Run  tests   first.', ['x', 'y']);
  const b = skill('b', 'run tests first.', ['y', 'x']);
  assert.strictEqual(skillFingerprint(a), skillFingerprint(b));
  const c = skill('c', 'run tests first.', ['y', 'x', 'z']);
  assert.notStrictEqual(skillFingerprint(a), skillFingerprint(c), '标签集不同 → 指纹不同');
});

test('② 同 corpus 连续 6 轮：适应度单调改善且多样性不塌缩', () => {
  const g = new DiversityGuard({ maxDuplicates: 2, minDistinctRatio: 0.5 });
  // 每轮最优适应度递增；种群按适应度降序给入（保首份即保最优）。
  const rounds: Array<{ best: number; pop: Skill[] }> = [
    { best: 0.5, pop: [skill('r0-a', '方案 A：查表化。'), skill('r0-b', '方案 B：前缀和。')] },
    {
      best: 0.6,
      pop: [skill('r1-a', '方案 A：查表化，加越界守卫。'), skill('r1-b', '方案 B：前缀和。')],
    },
    {
      best: 0.7,
      pop: [
        skill('r2-a', '方案 A：查表化，加越界守卫与缓存。'),
        skill('r2-b', '方案 B：前缀和，含负数。'),
      ],
    },
    {
      best: 0.8,
      pop: [
        skill('r3-a', '方案 A：查表化 + 越界守卫 + 缓存 + 二级表。'),
        skill('r3-b', '方案 B：前缀和，含负数与压缩。'),
      ],
    },
    {
      best: 0.9,
      pop: [
        skill('r4-a', '方案 A：查表化 + 守卫 + 缓存 + 二级表 + 预热。'),
        skill('r4-b', '方案 B：前缀和 + 压缩 + 分块。'),
      ],
    },
    {
      best: 0.95,
      pop: [
        skill('r5-a', '方案 A：全量查表化 + 守卫 + 缓存 + 二级表 + 预热 + 降级。'),
        skill('r5-b', '方案 B：前缀和 + 压缩 + 分块 + 并行。'),
      ],
    },
  ];
  let prevBest = -1;
  for (const [i, round] of rounds.entries()) {
    const r = g.admit(round.pop);
    assert.ok(round.best > prevBest, `第 ${i} 轮适应度应改善`);
    assert.strictEqual(r.collapsed, false, `第 ${i} 轮不得塌缩`);
    assert.ok(r.distinctRatio >= 0.5, `第 ${i} 轮去重率 ${r.distinctRatio} 应 ≥ 0.5`);
    prevBest = round.best;
  }
});

test('③ Echo 种群判塌缩：收紧阈值（0.8）后全同内容告警', () => {
  const g = new DiversityGuard({ maxDuplicates: 2, minDistinctRatio: 0.8 });
  const echo = [
    skill('e1', '同一句话。'),
    skill('e2', '同一句话。'),
    skill('e3', '同一句话。'),
    skill('e4', '同一句话。'),
  ];
  const r = g.admit(echo);
  assert.strictEqual(r.admitted.length, 2, '只放行配额内副本');
  assert.strictEqual(r.rejected.length, 2);
  assert.strictEqual(r.distinctRatio, 0.5);
  assert.strictEqual(r.collapsed, true, '去重率 0.5 < 0.8 → 塌缩告警');
});

test('③b 塌缩阈值边界：ratio == minDistinctRatio 不告警（< 才告警）', () => {
  const g = new DiversityGuard({ maxDuplicates: 2, minDistinctRatio: 0.5 });
  const r = g.admit([skill('a', '内容一。'), skill('b', '内容一。'), skill('c', '内容二。')]);
  assert.strictEqual(r.distinctRatio, 2 / 3);
  assert.strictEqual(r.collapsed, false);
});

test('④ 确定性：同候选序列重复 20 次准入结果完全一致', () => {
  const run = () => {
    const g = new DiversityGuard({ maxDuplicates: 2 });
    const r = g.admit([
      skill('x1', '内容甲。'),
      skill('x2', '内容甲。'),
      skill('x3', '内容甲。'),
      skill('y1', '内容乙。'),
    ]);
    return {
      admitted: r.admitted.map((s) => s.name),
      rejected: r.rejected.map((s) => s.name),
      ratio: r.distinctRatio,
    };
  };
  const first = run();
  for (let i = 0; i < 19; i++) assert.deepStrictEqual(run(), first, '同输入必须恒同结果');
  assert.deepStrictEqual(first.admitted, ['x1', 'x2', 'y1']);
  assert.deepStrictEqual(first.rejected, ['x3']);
});
