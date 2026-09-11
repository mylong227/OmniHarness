// (P2, I-P2-3) 粒子滤波信念：蒙特卡洛后验近似——重加权 + 低 ESS 系统重采样；退化观测 fail-closed
// 不崩溃；自然步进沿梯度推粒子。断言：
//   ① 反复观测真值 → 加权均值估计逼近真值、有效样本比(ESS)健康；
//   ② 离群极远观测 → 不崩溃、快照有限、置信低（fail-closed）；
//   ③ naturalStep 沿正梯度推粒子 → dim0 均值上升。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticleFilterBelief } from '../../src/adapters/belief/particleFilterBelief.js';

const TRUE = [1, 2, 3];

test('① 跟踪收敛：反复观测真值 → 加权均值估计逼近真值、ESS 健康', () => {
  const b = new ParticleFilterBelief({
    dim: 3,
    particles: 500,
    initialMean: 0,
    initialVariance: 4,
    seed: 42,
  });
  for (let t = 0; t < 40; t++) b.correct(TRUE, 0.5);
  const s = b.snapshot();
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(s.mean[i]! - TRUE[i]!) < 0.25, `dim${i} 估计应逼近真值`);
  }
  assert.ok(s.confidence > 0.5, '有效样本比(ESS/N)应健康');
  assert.ok(
    s.variance.every((v) => v > 0),
    '方差应正',
  );
});

test('② 退化观测 fail-closed：离所有粒子极远 → 不崩溃、快照有限、置信有效', () => {
  const b = new ParticleFilterBelief({
    dim: 2,
    particles: 100,
    initialMean: 0,
    initialVariance: 1,
    seed: 7,
  });
  assert.doesNotThrow(() => b.correct([1e9, -1e9], 0.01), '离群极远观测不应崩溃');
  const s = b.snapshot();
  assert.ok(isFinite(s.mean[0]!) && isFinite(s.mean[1]!), '均值快照应有限');
  assert.ok(isFinite(s.variance[0]!) && isFinite(s.confidence), '方差/置信应有限');
  assert.ok(s.confidence >= 0 && s.confidence <= 1, '置信（有效样本比 ESS/N）应落在 [0,1]');
});

test('③ 自然步进沿梯度推粒子：正梯度 → dim0 均值上升', () => {
  const b = new ParticleFilterBelief({
    dim: 3,
    particles: 300,
    initialMean: 0,
    initialVariance: 1,
    seed: 11,
  });
  const before = b.snapshot();
  b.naturalStep([1, 0, 0], 0.5);
  const after = b.snapshot();
  assert.ok(after.mean[0]! > before.mean[0]!, 'dim0 应沿正梯度上升');
});
