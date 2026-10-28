/**
 * A/B 统计口径判据：pass@k / pass^k / tokensPerSolved / paired delta。
 * 这些数字会直接进评测报告，口径错一次就会把噪声写成收益。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AbMetrics, type AbRun } from '../../src/eval/abMetrics.ts';

test('summarize：pass@k 与 pass^k 不是同一个指标', () => {
  const runs: AbRun[] = [
    { ok: true, tokens: 100, wallMs: 10 },
    { ok: false, tokens: 200, wallMs: 20 },
    { ok: true, tokens: 300, wallMs: 30 },
  ];
  const summary = AbMetrics.summarize(runs);
  assert.strictEqual(summary.runs, 3);
  assert.strictEqual(summary.successes, 2);
  assert.strictEqual(summary.passAtK, true);
  assert.strictEqual(summary.passAllK, false, '2/3 不能算 pass^k');
  assert.strictEqual(summary.tokens, 600);
  assert.strictEqual(summary.tokensPerSolved, 300);
});

test('summarize：全失败时 tokensPerSolved 为 null（不臆造 0）', () => {
  const summary = AbMetrics.summarize([{ ok: false, tokens: 50, wallMs: 1 }]);
  assert.strictEqual(summary.passAtK, false);
  assert.strictEqual(summary.passAllK, false);
  assert.strictEqual(summary.tokensPerSolved, null);
});

test('summarize：成功但端点没回传 usage 时 tokensPerSolved 也是 null（未知≠0）', () => {
  const summary = AbMetrics.summarize([{ ok: true, tokens: 0, wallMs: 1 }]);
  assert.strictEqual(summary.passAtK, true);
  assert.strictEqual(summary.tokensPerSolved, null);
});

test('summarize：空 run 集不宣称成功', () => {
  const summary = AbMetrics.summarize([]);
  assert.strictEqual(summary.passAtK, false);
  assert.strictEqual(summary.passAllK, false);
  assert.strictEqual(summary.tokensPerSolved, null);
});

test('paired：成功率差与 token 比按下标对齐', () => {
  const a: AbRun[] = [
    { ok: true, tokens: 100, wallMs: 1 },
    { ok: false, tokens: 100, wallMs: 1 },
  ];
  const b: AbRun[] = [
    { ok: true, tokens: 200, wallMs: 1 },
    { ok: true, tokens: 200, wallMs: 1 },
  ];
  const delta = AbMetrics.paired(a, b);
  assert.strictEqual(delta.n, 2);
  assert.strictEqual(delta.successDelta, 0.5);
  assert.strictEqual(delta.tokenRatio, 2);
});

test('paired：长度不等时取较短者，A 为 0 token 时比值为 null', () => {
  const delta = AbMetrics.paired([], [{ ok: true, tokens: 1, wallMs: 1 }]);
  assert.deepStrictEqual(delta, {
    n: 0,
    successDelta: 0,
    tokenRatio: null,
    successDeltaCi95: [0, 0],
    mde80: 0,
  });
  const zero = AbMetrics.paired(
    [{ ok: true, tokens: 0, wallMs: 1 }],
    [{ ok: true, tokens: 10, wallMs: 1 }],
  );
  assert.strictEqual(zero.tokenRatio, null);
});

test('paired：给出配对 bootstrap CI 与 MDE 近似，且可复算', () => {
  const a: AbRun[] = Array.from({ length: 20 }, (_, i) => ({
    ok: i < 10,
    tokens: 100,
    wallMs: 1,
  }));
  const b: AbRun[] = Array.from({ length: 20 }, (_, i) => ({
    ok: i < 12,
    tokens: 100,
    wallMs: 1,
  }));
  const first = AbMetrics.paired(a, b);
  const second = AbMetrics.paired(a, b);
  assert.strictEqual(first.successDelta, 0.1);
  assert.ok(first.successDeltaCi95[0] <= 0.1 && first.successDeltaCi95[1] >= 0.1);
  assert.ok(first.mde80 > 0, '有噪声时 MDE 应为正');
  assert.deepStrictEqual(second, first, '固定种子 ⇒ 同数据必须同区间');
});

test('paired：样本 <3 不假装有区间', () => {
  const delta = AbMetrics.paired(
    [{ ok: true, tokens: 1, wallMs: 1 }],
    [{ ok: false, tokens: 1, wallMs: 1 }],
  );
  assert.deepStrictEqual(delta.successDeltaCi95, [-1, -1]);
  assert.strictEqual(delta.mde80, 1);
});
