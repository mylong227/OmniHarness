// T5.3（退火接受）可证伪验收：
//   ① 优/平解恒接受（不消耗随机数、不依赖种子）；
//   ② 劣解接受率随温度单调：高温显著更易接受（免费增益的机制来源）；
//   ③ 可复现：同种子 + 同事件序列恒同接受序列（20 次重放完全一致）；
//   ④ 温度单调不升；冷却到低温后劣解几乎不再被接受（收敛性）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnealedAcceptance } from '../../src/evolution/annealedAcceptance.js';

test('① 优解/平解恒接受，概率恒 1', () => {
  const a = new AnnealedAcceptance({ seed: 7 });
  for (let i = 0; i < 50; i++) {
    const d1 = a.decide(0.5, 0.6); // 候选更优
    assert.strictEqual(d1.accepted, true);
    assert.strictEqual(d1.probability, 1);
    const d2 = a.decide(0.5, 0.5); // 平
    assert.strictEqual(d2.accepted, true);
  }
});

test('② 高温 vs 低温：同 Δ 下高温接受率显著更高', () => {
  const hot = new AnnealedAcceptance({ seed: 42, initialTemperature: 1.0, cooling: 1 });
  const cold = new AnnealedAcceptance({ seed: 42, initialTemperature: 0.01, cooling: 1 });
  let hotAccepted = 0;
  let coldAccepted = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (hot.decide(1.0, 0.9).accepted) hotAccepted += 1; // Δ=0.1
    if (cold.decide(1.0, 0.9).accepted) coldAccepted += 1;
  }
  // 理论概率：hot ≈ exp(-0.1/1)≈0.905，cold ≈ exp(-10)≈0。同种子序列下统计比较仍有巨大差。
  assert.ok(hotAccepted > N * 0.8, `高温应大量接受劣解（${hotAccepted}/${N}）`);
  assert.strictEqual(coldAccepted, 0, `低温应几乎从不接受（实际 ${coldAccepted}/${N}）`);
});

test('③ 可复现：同种子同序列 20 次重放接受序列完全一致', () => {
  const run = () => {
    const a = new AnnealedAcceptance({ seed: 20260913, initialTemperature: 0.5, cooling: 0.9 });
    const deltas = [0.2, -0.1, 0.05, 0.3, -0.2, 0.01];
    const out: boolean[] = [];
    let cur = 1.0;
    for (const d of deltas) {
      const cand = cur - d;
      const decision = a.decide(cur, cand);
      out.push(decision.accepted);
      if (decision.accepted) cur = cand;
    }
    return out;
  };
  const first = run();
  for (let i = 0; i < 19; i++) assert.deepStrictEqual(run(), first, '同种子必须恒同接受序列');
});

test('④ 温度单调不升；低温收敛后劣解几乎不被接受', () => {
  const a = new AnnealedAcceptance({ seed: 3, initialTemperature: 2.0, cooling: 0.8 });
  let prev = a.temperature;
  for (let i = 0; i < 100; i++) {
    a.decide(1.0, 0.5); // 恒定 Δ=0.5 劣解
    assert.ok(a.temperature <= prev + 1e-15, '温度必须单调不升');
    prev = a.temperature;
  }
  const late = a.decide(1.0, 0.5);
  assert.strictEqual(late.accepted, false, '低温下 Δ=0.5 的劣解应几乎不被接受');
});
