import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePassK,
  summarizePassK,
  bootstrapPassK,
  passKGateWithCI,
} from '../../src/eval/passK.js';
import { mulberry32, percentile, bootstrapInterval } from '../../src/eval/bootstrap.js';

test('mulberry32: 同种子同序列，异种子异序列', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const c = mulberry32(54321);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepStrictEqual(seqA, seqB);
  assert.notDeepStrictEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('percentile: 最近秩取值与边界夹取', () => {
  const s = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.strictEqual(percentile(s, 0), 0);
  assert.strictEqual(percentile(s, 1), 9);
  assert.strictEqual(percentile(s, -1), 0); // 夹取下界
  assert.strictEqual(percentile(s, 2), 9); // 夹取上界
  assert.strictEqual(percentile([], 0.5), 0);
});

test('bootstrapInterval: 同种子可复现；空输入退化', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const stat = (rs: readonly number[]): number => rs.reduce((s, v) => s + v, 0) / rs.length;
  const r1 = bootstrapInterval(items, stat, { seed: 7, rounds: 500 });
  const r2 = bootstrapInterval(items, stat, { seed: 7, rounds: 500 });
  assert.deepStrictEqual(r1, r2);
  assert.ok(r1.lo <= r1.mean && r1.mean <= r1.hi);
  const empty = bootstrapInterval<number>([], stat, { rounds: 100 });
  assert.deepStrictEqual(empty, { mean: 0, lo: 0, hi: 0, rounds: 100 });
});

test('bootstrapPassK: 点估计等于 computePassK，且区间包住点估计', () => {
  const outcomes = [
    [true, false, true],
    [false, false, true],
    [true, true, true],
    [false, true, false],
  ];
  const report = bootstrapPassK(outcomes, 2);
  const point = computePassK(outcomes, 2);
  assert.strictEqual(report.passAtKCI.length, 2);
  for (let k = 0; k < 2; k++) {
    const ci = report.passAtKCI[k]!;
    const p = point[k]!;
    assert.ok(
      ci.lo <= p + 1e-9 && p <= ci.hi + 1e-9,
      `k=${k + 1} 区间 [${ci.lo},${ci.hi}] 未包住 ${p}`,
    );
  }
});

test('bootstrapPassK: 全通过 ⇒ Pass@k 区间恒为 1', () => {
  const report = bootstrapPassK(
    [
      [true, true],
      [true, true, true],
    ],
    2,
  );
  for (const ci of report.passAtKCI) {
    assert.strictEqual(ci.lo, 1);
    assert.strictEqual(ci.hi, 1);
  }
  assert.strictEqual(report.summary.passAtK[0], 1);
});

test('passKGateWithCI: 全通过且阈值达标 ⇒ passed', () => {
  const report = bootstrapPassK(
    [
      [true, true],
      [true, true, true],
    ],
    2,
  );
  const g = passKGateWithCI(report, { minPassRate: 0.9, minPassK: [{ k: 2, threshold: 0.9 }] });
  assert.strictEqual(g.passed, true);
  assert.strictEqual(g.failures.length, 0);
  assert.strictEqual(g.inconclusive.length, 0);
});

test('passKGateWithCI: 全失败 ⇒ 显著不达标（失败项非空）', () => {
  const report = bootstrapPassK(
    [
      [false, false],
      [false, false, false],
    ],
    2,
  );
  const g = passKGateWithCI(report, { minPassRate: 0.5, minPassK: [{ k: 2, threshold: 0.5 }] });
  assert.strictEqual(g.passed, false);
  assert.ok(g.failures.length > 0);
});

test('passKGateWithCI: 区间跨阈值 ⇒ inconclusive（fail-closed）', () => {
  // 8 任务各 1 采样、真假交替 ⇒ 通过率点估计 0.5，bootstrap 区间宽且跨 0.5。
  const outcomes: boolean[][] = [];
  for (let i = 0; i < 8; i++) outcomes.push([i % 2 === 0]);
  const report = bootstrapPassK(outcomes, 1);
  const g = passKGateWithCI(report, { minPassRate: 0.5 });
  assert.strictEqual(g.passed, false);
  assert.ok(g.inconclusive.length > 0, `期望 inconclusive，实得 ${JSON.stringify(g)}`);
  assert.strictEqual(g.failures.length, 0);
});

test('passKGateWithCI: 默认阈值 0 不会虚假失败', () => {
  const report = bootstrapPassK(
    [
      [true, false],
      [false, false],
    ],
    1,
  );
  const g = passKGateWithCI(report, {});
  assert.strictEqual(g.passed, true);
});

test('T4.7 验收：同一输入重复判定 20 次结果完全稳定', () => {
  const outcomes = [
    [true, false, false],
    [true, true, false],
    [false, false, true],
    [true, false, true],
    [false, true, false],
  ];
  const verdicts = new Set<string>();
  for (let i = 0; i < 20; i++) {
    // 每次从零重算（含重采样）——种子固定故应恒同。
    const g = passKGateWithCI(bootstrapPassK(outcomes, 3), {
      minPassRate: 0.4,
      minPassK: [{ k: 3, threshold: 0.6 }],
    });
    verdicts.add(JSON.stringify(g));
  }
  assert.strictEqual(
    verdicts.size,
    1,
    `20 次判定出现 ${verdicts.size} 种结果：${[...verdicts].join(' | ')}`,
  );
});

test('T4.7 验收：bootstrapPassK 两次调用结果逐字段一致', () => {
  const outcomes = [
    [true, true, false],
    [false, true, true],
    [true, false, false],
  ];
  assert.deepStrictEqual(bootstrapPassK(outcomes, 3), bootstrapPassK(outcomes, 3));
  assert.deepStrictEqual(summarizePassK(outcomes, 3), bootstrapPassK(outcomes, 3).summary);
});
