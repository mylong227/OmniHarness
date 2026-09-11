// (P3, I-P3-3) 对称破缺算子：以经验密度（使用非对称度）为序参量 ρ，越过阈值 → 对称破缺可观测。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymmetryBreakingEngine } from '../../src/adapters/monitoring/symmetryBreakingEngine.js';

test('① 初始对称态：ρ=0、无占优能力', () => {
  const s = new SymmetryBreakingEngine();
  const snap = s.snapshot();
  assert.strictEqual(snap.orderParameter, 0);
  assert.strictEqual(snap.state, 'symmetric');
  assert.strictEqual(snap.brokenState, undefined);
});

test('② 占优能力累积越过阈值 → 破缺，可观测 brokenState 与相变', () => {
  const s = new SymmetryBreakingEngine({ threshold: 0.6 });
  // 单一能力持续被用 → 主导度 ρ 向 1 攀升。
  const t1 = s.observe([{ capability: 'core-skill', weight: 1 }]);
  const snap = s.snapshot();
  assert.strictEqual(snap.orderParameter, 1, '单一占优 → ρ=1');
  assert.strictEqual(snap.state, 'broken', '应破缺为非对称态');
  assert.strictEqual(snap.brokenState, 'core-skill', '应记录占优能力');
  assert.strictEqual(t1, true, '本次应发生相变');
});

test('③ fail-closed：迟滞保持破缺，须显式 reset 才回对称态', () => {
  const s = new SymmetryBreakingEngine({ threshold: 0.6 });
  s.observe([{ capability: 'a', weight: 5 }]);
  assert.strictEqual(s.snapshot().state, 'broken');
  // 之后单一低样本不应把已破缺态弹回（迟滞）。
  s.observe([{ capability: 'b', weight: 1 }]);
  assert.strictEqual(s.snapshot().state, 'broken', '已破缺应保持（迟滞）');
  s.reset();
  const after = s.snapshot();
  assert.strictEqual(after.state, 'symmetric', 'reset 后回对称态');
  assert.strictEqual(after.brokenState, undefined);
});

test('④ 多能力均衡 → 维持对称态（未越过阈值）', () => {
  const s = new SymmetryBreakingEngine({ threshold: 0.6 });
  s.observe([
    { capability: 'a', weight: 1 },
    { capability: 'b', weight: 1 },
    { capability: 'c', weight: 1 },
  ]);
  const snap = s.snapshot();
  assert.strictEqual(snap.orderParameter, 1 / 3, '均衡 → ρ=1/3');
  assert.strictEqual(snap.state, 'symmetric', '未越阈 → 对称态');
});
