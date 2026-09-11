// (P2, I-P2-2) 自然梯度信念：信息几何——Fisher 度规预处理步进 + 贝叶斯观测修正，均返回
// 可审计 KL 分解（均值漂移 / 方差变化 / 逐维明细）+ 重参数化不变性审计。断言：
//   ① naturalStep 均值增量 = η·σ²·g（Fisher 预处理），方差不变 → 方差 KL≈0；
//   ② correct 收紧后验（方差下降、均值落于先验与观测之间），KL 两分量皆正；
//   ③ KL 逐维之和 = 总量（可审计一致性）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NaturalGradientBelief } from '../../src/adapters/belief/naturalGradientBelief.js';

test('① 自然梯度沿 Fisher 度规预处理步进：Δμ = η·σ²·g；KL 仅均值漂移分量', () => {
  const b = new NaturalGradientBelief({ dim: 3, initialVariance: 4 });
  const before = b.snapshot();
  const g = [1, 0, -2];
  const lr = 0.5;
  const rep = b.naturalStep(g, lr);
  const after = b.snapshot();
  // 自然梯度：Δμ = η · F⁻¹ · g = η · σ² · g = 0.5 · 4 · g = 2g。
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(after.mean[i]! - (before.mean[i]! + lr * 4 * g[i]!)) < 1e-9,
      `dim${i} 自然梯度增量应为 η·σ²·g`,
    );
  }
  // 方差不变 → 方差 KL 分量应为 0。
  assert.ok(Math.abs(rep.kl.variance) < 1e-12, '自然步进方差不变 → 方差 KL≈0');
  assert.ok(rep.kl.meanShift > 0, '均值漂移 KL 应 > 0');
  assert.ok(Math.abs(rep.kl.total - rep.kl.meanShift) < 1e-9, '总量应等于均值漂移分量');
  assert.strictEqual(rep.reparamInvariant, true, '重参数化不变性审计应过');
});

test('② 贝叶斯 correct 收紧后验：方差下降、均值落于先验与观测之间；KL 两分量皆正', () => {
  const b = new NaturalGradientBelief({ dim: 2, initialVariance: 9 });
  const rep = b.correct([3, -1], 1);
  const after = b.snapshot();
  for (let i = 0; i < 2; i++) {
    assert.ok(after.variance[i]! < 9, `dim${i} 后验方差应较先验(9)收紧`);
  }
  assert.ok(after.mean[0]! > 0 && after.mean[0]! < 3, 'dim0 后验均值应介于先验0与观测3之间');
  assert.ok(after.mean[1]! < 0 && after.mean[1]! > -1, 'dim1 后验均值应介于 0 与 -1 之间');
  assert.ok(rep.kl.meanShift > 0, '均值漂移分量应正');
  assert.ok(rep.kl.variance > 0, '方差变化分量应正（后验更集中）');
  assert.ok(Math.abs(rep.kl.total - (rep.kl.meanShift + rep.kl.variance)) < 1e-9);
  assert.strictEqual(rep.reparamInvariant, true);
});

test('③ KL 分解逐维求和等于总量（可审计一致性）', () => {
  const b = new NaturalGradientBelief({ dim: 4, initialVariance: 2 });
  const rep = b.correct([1, 2, 3, 4], 0.7);
  const sumDim = rep.kl.perDimension.reduce((a, c) => a + c.total, 0);
  assert.ok(Math.abs(sumDim - rep.kl.total) < 1e-9, '逐维 KL 之和应等于总量');
});
