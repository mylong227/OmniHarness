/**
 * 排序前置否决器单测：锁定「查询敏感度」主判据的行为与「结构性度量仅作诊断」的契约。
 *
 * 断言策略：**不锁死阈值**（阈值标定样本量极小，后续会随新样本校正），
 * 而是锁定行为契约——常量路由必须被否决、查询专属路由必须放行、
 * 结构性指标不得单独触发否决、退化输入不崩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RankVetoEvaluator, RankVetoOverlap } from '../../src/context/rankVeto/index.js';

/** 构造无向完全图 K_n。 */
function completeGraph(n: number): { n: number; adj: Array<Array<[number, number]>> } {
  const adj: Array<Array<[number, number]>> = [];
  for (let i = 0; i < n; i++) {
    const row: Array<[number, number]> = [];
    for (let j = 0; j < n; j++) if (j !== i) row.push([j, 1]);
    adj.push(row);
  }
  return { n, adj };
}

/** 构造「常量路由」探针：所有查询返回同一批文件（复现已知图路由的失效形态）。 */
function constantProbe(): string[][] {
  const same = ['hub/a.ts', 'hub/b.ts', 'hub/c.ts', 'hub/d.ts'];
  return [same.slice(), same.slice(), same.slice(), same.slice()];
}

/** 构造「查询专属路由」探针：各查询返回互不相交的文件（复现 BM25 的有效形态）。 */
function distinctProbe(): string[][] {
  return [
    ['a1.ts', 'a2.ts', 'a3.ts'],
    ['b1.ts', 'b2.ts', 'b3.ts'],
    ['c1.ts', 'c2.ts', 'c3.ts'],
    ['d1.ts', 'd2.ts', 'd3.ts'],
  ];
}

test('meanPairwiseJaccard：全同=1、全异=0、样本不足=null', () => {
  assert.strictEqual(RankVetoOverlap.meanPairwiseJaccard(constantProbe()), 1);
  assert.strictEqual(RankVetoOverlap.meanPairwiseJaccard(distinctProbe()), 0);
  assert.strictEqual(RankVetoOverlap.meanPairwiseJaccard([['a.ts']]), null);
  assert.strictEqual(RankVetoOverlap.meanPairwiseJaccard([]), null);
});

test('常量路由被否决：查询不敏感度达上限', () => {
  const report = new RankVetoEvaluator().evaluate({
    candidateProbeLists: constantProbe(),
    baselineProbeLists: distinctProbe(),
  });
  assert.strictEqual(report.verdict, 'veto');
  assert.strictEqual(report.metrics.queryInsensitivity, 1);
  assert.strictEqual(report.metrics.baselineQueryInsensitivity, 0);
  assert.ok(
    report.reasons.some((r) => r.includes('查询不敏感度')),
    '应命中查询敏感度判据',
  );
});

test('查询专属路由放行（对照：BM25 形态）', () => {
  const report = new RankVetoEvaluator().evaluate({
    candidateProbeLists: distinctProbe(),
    baselineProbeLists: distinctProbe(),
  });
  assert.strictEqual(report.verdict, 'proceed');
  assert.strictEqual(report.reasons.length, 0);
});

test('结构性指标单独不得触发否决——回溯验证已证伪其判别力', () => {
  // 完全图是「最退化」的图：谱隙大、稳态完全均匀、度 Gini=0。
  // 但已知负样本（真实稠密图）实测谱隙仅 0.2795、支撑率 0.5934，该族判据当年一条都没触发。
  // 因此这里断言：只给图、不给探针时，**结论必须是放行 + 诊断提示**。
  const report = new RankVetoEvaluator().evaluate({ graph: completeGraph(8) });
  assert.strictEqual(report.verdict, 'proceed', '结构性指标不得单独否决');
  assert.strictEqual(report.reasons.length, 0);
  assert.ok(report.notes.length > 0, '应给出诊断提示');
  assert.ok(
    report.notes.every((n) => n.includes('未通过回溯验证') || n.includes('[诊断]')),
    '诊断提示须显式标注验证状态',
  );
  // 度量仍然照算，便于存档与复核。
  assert.ok(
    report.metrics.effectiveSupportRatio !== null && report.metrics.effectiveSupportRatio > 0.99,
  );
  assert.ok(report.metrics.degreeGini !== null && report.metrics.degreeGini < 0.01);
  assert.ok(report.metrics.spectralGap !== null && report.metrics.spectralGap > 0.5);
});

test('与基线重合度过高会被否决（预先承诺的失败判据）', () => {
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
  const report = new RankVetoEvaluator().evaluate({
    baselineFiles: files,
    candidateFiles: files.slice(),
  });
  assert.strictEqual(report.metrics.overlapJaccard, 1);
  assert.strictEqual(report.verdict, 'veto');
  assert.ok(report.reasons.some((r) => r.includes('重合度')));
});

test('jaccardOverlap 精确：全等=1、互斥=0、半重叠=1/3', () => {
  assert.strictEqual(RankVetoOverlap.jaccardOverlap(['a', 'b'], ['a', 'b']), 1);
  assert.strictEqual(RankVetoOverlap.jaccardOverlap(['a', 'b'], ['c', 'd']), 0);
  assert.strictEqual(RankVetoOverlap.jaccardOverlap(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.strictEqual(RankVetoOverlap.jaccardOverlap([], []), 1);
});

test('确定性：同输入两次评估完全一致（无随机数依赖）', () => {
  const input = {
    graph: completeGraph(7),
    candidateProbeLists: constantProbe(),
    baselineProbeLists: distinctProbe(),
  };
  const a = new RankVetoEvaluator().evaluate(input);
  const b = new RankVetoEvaluator().evaluate(input);
  assert.deepEqual(a, b);
});

test('退化输入不崩：空图返回 proceed + 诊断，而非抛错', () => {
  const report = new RankVetoEvaluator().evaluate({ graph: { n: 0, adj: [] } });
  assert.strictEqual(report.metrics.nodeCount, 0);
  assert.strictEqual(report.metrics.avgDegree, 0);
  assert.strictEqual(report.verdict, 'proceed');
});

test('阈值可注入：放宽后常量路由可放行', () => {
  const input = { candidateProbeLists: constantProbe() };
  assert.strictEqual(new RankVetoEvaluator().evaluate(input).verdict, 'veto');
  assert.strictEqual(
    new RankVetoEvaluator({ maxQueryInsensitivity: 2, maxOverlapJaccard: 2 }).evaluate(input)
      .verdict,
    'proceed',
  );
});
