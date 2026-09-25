import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassK } from '../../src/eval/passK.js';

test('combination: 边界与对称性', () => {
  assert.strictEqual(PassK.combination(5, 0), 1);
  assert.strictEqual(PassK.combination(5, 5), 1);
  assert.strictEqual(PassK.combination(5, 2), 10);
  assert.strictEqual(PassK.combination(5, 3), 10);
  assert.strictEqual(PassK.combination(5, 6), 0); // k>n
});

test('computePassK: 全通过 → 所有 k 均为 1', () => {
  const outcomes = [
    [true, true],
    [true, true, true],
  ];
  const r = PassK.computePassK(outcomes, 3);
  for (const v of r) assert.strictEqual(v, 1);
});

test('computePassK: 全失败 → 所有 k 均为 0', () => {
  const outcomes = [
    [false, false],
    [false, false],
  ];
  const r = PassK.computePassK(outcomes, 2);
  for (const v of r) assert.strictEqual(v, 0);
});

test('computePassK: 单任务 4 采样 2 通过 → Pass@1=0.5, Pass@2=1', () => {
  // n=4,c=2: Pass@1 = 1 - C(2,1)/C(4,1) = 1 - 2/4 = 0.5
  // Pass@2 = 1 - C(2,2)/C(4,2) = 1 - 1/6 ≈ 0.8333
  const r = PassK.computePassK([[true, false, true, false]], 2);
  assert.ok(Math.abs(r[0]! - 0.5) < 1e-9);
  assert.ok(Math.abs(r[1]! - (1 - 1 / 6)) < 1e-9);
});

test('computePassK: k>n 时视为 1（不惩罚样本全错）', () => {
  const r = PassK.computePassK([[true, false]], 5); // n=2,k=5 → 1
  assert.strictEqual(r[4], 1);
});

test('meanPassRate: 加权正确', () => {
  // [true,true]=2/2, [false,true,true]=2/3 → 总计 4/5。
  assert.strictEqual(
    PassK.meanPassRate([
      [true, true],
      [false, true, true],
    ]),
    4 / 5,
  );
});

test('summarizePassK: 结构完整', () => {
  const s = PassK.summarizePassK(
    [
      [true, false],
      [true, true],
    ],
    2,
  );
  assert.strictEqual(s.tasks, 2);
  assert.strictEqual(s.totalSamples, 4);
  assert.ok(Math.abs(s.meanPassRate - 0.75) < 1e-9);
  assert.strictEqual(s.passAtK.length, 2);
});

test('passKGate: 通过率达标 → passed', () => {
  const s = PassK.summarizePassK(
    [
      [true, true],
      [true, false, true],
    ],
    1,
  );
  const g = PassK.passKGate(s, { minPassRate: 0.6 });
  assert.strictEqual(g.passed, true);
  assert.strictEqual(g.failures.length, 0);
});

test('passKGate: 通过率不达标 → 列出失败', () => {
  const s = PassK.summarizePassK(
    [
      [false, false],
      [true, false],
    ],
    1,
  );
  const g = PassK.passKGate(s, { minPassRate: 0.8 });
  assert.strictEqual(g.passed, false);
  assert.ok(g.failures.some((f) => f.includes('通过率')));
});

test('passKGate: Pass@k 阈值', () => {
  // 单任务 4 采样 2 通过：Pass@1 = 1 - C(2,1)/C(4,1) = 0.5；Pass@2 = 1 - C(2,2)/C(4,2) ≈ 0.833。
  const s = PassK.summarizePassK([[true, true, false, false]], 2);
  assert.ok(Math.abs(s.passAtK[0]! - 0.5) < 1e-9);
  assert.ok(Math.abs(s.passAtK[1]! - (1 - 1 / 6)) < 1e-9);
  const g = PassK.passKGate(s, { minPassK: [{ k: 2, threshold: 0.9 }] });
  assert.strictEqual(g.passed, false);
  const ok = PassK.passKGate(s, { minPassK: [{ k: 2, threshold: 0.7 }] });
  assert.strictEqual(ok.passed, true);
});
