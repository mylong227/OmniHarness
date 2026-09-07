// (E, I-P1-5) 免疫异常监控：训练自体检测器 → 偏离自体即告警；同签名记忆细胞二次加速；
// 自检返回自体规模与最近异常。断言：① 无基线时不报；② 训练后正常样本不报、异常样本告警；
// ③ 同签名二次出现仍告警（记忆细胞）；④ selfCheck 反映自体规模与最近异常。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ImmuneMonitor } from '../../src/adapters/monitoring/immuneMonitor.js';

function trainNormal(m: ImmuneMonitor, base: number[], n = 12): void {
  for (let i = 0; i < n; i++) {
    const sample = base.map((v) => v + (Math.random() - 0.5) * 0.4);
    m.train(sample);
  }
}

test('① 无基线（未训练）观察不告警', () => {
  const m = new ImmuneMonitor({ threshold: 3 });
  assert.strictEqual(m.observe([100, 100]), null, '未训练不应告警');
  assert.strictEqual(m.selfCheck().selfSize, 0);
});

test('② 训练后：正常样本不报、异常样本告警', () => {
  const m = new ImmuneMonitor({ threshold: 3 });
  trainNormal(m, [10, 5]);
  assert.strictEqual(m.observe([10.1, 5.0]), null, '正常样本应在自体分布内');
  const alert = m.observe([100, 5]); // 第 0 维严重偏离
  assert.ok(alert !== null, '异常样本应告警');
  assert.strictEqual(alert!.signature, 'd0', '异常签名应标记偏离维度 0');
  assert.ok(['warn', 'critical'].includes(alert!.severity));
});

test('③ 同签名二次出现仍告警（记忆细胞加速响应）', () => {
  const m = new ImmuneMonitor({ threshold: 3 });
  trainNormal(m, [10, 5]);
  const a1 = m.observe([100, 5]);
  const a2 = m.observe([100, 5]); // 同签名
  assert.ok(a1 !== null && a2 !== null, '同签名异常应持续告警');
  assert.strictEqual(a1!.signature, a2!.signature, '两次签名应一致（记忆细胞）');
});

test('④ selfCheck 反映自体规模与最近异常', () => {
  const m = new ImmuneMonitor({ threshold: 3 });
  trainNormal(m, [10, 5]);
  m.observe([100, 5]);
  const rep = m.selfCheck();
  assert.strictEqual(rep.selfSize, 12, '自体规模应等于训练样本数');
  assert.ok(rep.lastAnomaly !== null, '最近异常应被记录');
  assert.strictEqual(rep.lastAnomaly!.signature, 'd0');
});
