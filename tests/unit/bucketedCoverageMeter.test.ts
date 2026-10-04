/**
 * S5（GEE Kernel v1 · ADR-0008）：覆盖率分桶判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S5）：
 * - 同一候选集：分桶口径**不劣化**——健康且均匀的场景下与全局口径同判（最差桶 = 全局）；
 * - **变异**：「单桶拥挤」场景下全局口径放行（覆盖率 ≥ 阈值）而最差桶 < 阈值 ⇒ 分桶口径阻断
 *   （去掉分桶即漏放 ⇒ 变异可杀）；阈值沿用 `COVERAGE_THRESHOLD`（不改口径）；
 * - 附加：探针只求值一次（分桶不让真实验证多跑）/ 桶键派生确定性 / 闸端到端取最差桶。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BucketedCoverageMeter } from '../../src/evolution/bucketedCoverageMeter.js';
import {
  RewardCoverageMeter,
  COVERAGE_THRESHOLD,
} from '../../src/evolution/rewardCoverageMeter.js';
import type { RewardVerdict } from '../../src/evolution/rewardCoverageMeter.js';
import { RlvrEvolutionController, RlvrController } from '../../src/evolution/rlvrController.js';
import { PromotionAdmission } from '../../src/evolution/promotionAdmission.js';
import type { EvolutionController, PromotionVerdict } from '../../src/ports/runtime/evolution.js';

/**
 * 造采样候选（带工况来源的 `meta.source`）。
 * @param source 候选来源（如 `twist:a+b`）
 * @param id 候选 id
 * @returns 候选形状对象
 */
function candidateOf(source: string, id = 's0'): { id: string; meta: { source: string } } {
  return { id, meta: { source } };
}

/**
 * 按来源给判据：`twist` 工况「验证跑不动」（不可验证），其余工况真实通过。
 * @param candidate 候选
 * @returns 判据明细
 */
function verdictBySource(candidate: unknown): RewardVerdict {
  const source = (candidate as { meta?: { source?: string } }).meta?.source ?? '';
  return source.startsWith('twist')
    ? { reward: 0, verifiable: false, reason: 'unverifiable:no-command' }
    : { reward: 1, verifiable: true, reason: 'verified-pass' };
}

/**
 * 造一条晋升裁决（闸判据用）。
 * @param name 技能名
 * @returns 晋升裁决
 */
function promotedVerdict(name: string): PromotionVerdict {
  return {
    candidate: {
      skill: { name, description: name, instructions: `${name} 步骤` },
      source: 'twist:x',
    },
    promoted: true,
    score: 0.9,
    baselineScore: 0.5,
    safety: 'pass',
    reason: 'stub',
  };
}

/**
 * 造「一次吐出给定裁决」的桩控制器。
 * @param verdicts 桩裁决流
 * @returns 桩控制器
 */
function stubInner(verdicts: readonly PromotionVerdict[]): EvolutionController {
  return {
    autoRun: false,
    evaluate: (candidate) =>
      Promise.resolve(
        verdicts[0] ??
          // 未给定裁决时按候选回一条「未晋升」（本测只走 `cycle()` 路径，evaluate 仅为契约齐全）。
          {
            candidate,
            promoted: false,
            score: 0,
            baselineScore: 0,
            safety: 'pass' as const,
            reason: 'stub',
          },
      ),
    cycle: () => Promise.resolve(verdicts),
    budgetUsed: () => ({ generated: verdicts.length, maxCandidates: verdicts.length }),
  };
}

test('S5 分桶记账：同一样本记进全局与所属桶，逐桶明细按覆盖率升序（确定性）', async () => {
  const meter = new BucketedCoverageMeter();
  const reward = meter.wrap({ verify: (c) => Promise.resolve(verdictBySource(c)) });
  await reward(candidateOf('twist:a+b'));
  await reward(candidateOf('archive:r1'));
  await reward(candidateOf('archive:r2'));
  const report = meter.report();
  assert.strictEqual(report.global.samples, 3);
  assert.strictEqual(report.coverage, 0, '最差桶 twist 覆盖率 0');
  assert.strictEqual(report.worstBucket, 'twist');
  assert.deepStrictEqual(report.bucketCoverage, [
    { bucket: 'twist', samples: 1, coverage: 0 },
    { bucket: 'archive', samples: 2, coverage: 1 },
  ]);
  assert.match(report.honestNote, /最差工况桶 twist/);
  assert.match(report.honestNote, /不得声称有效 RLVR/, '降级措辞只有一处实现（沿用既有口径）');
});

test('S5 不劣化：健康且均匀的样本集上最差桶 = 全局口径（分桶不改变健康场景的判定）', async () => {
  const meter = new BucketedCoverageMeter();
  const reward = meter.wrap({ verify: (c) => Promise.resolve(verdictBySource(c)) });
  for (const source of ['archive:a', 'archive:b', 'signed:c', 'other:d'])
    await reward(candidateOf(source));
  // 全部 verified（`verdictBySource` 只把 `twist` 前缀判为不可验证；本场景不含 twist）。
  const report = meter.report();
  assert.strictEqual(report.global.coverage, 1);
  assert.strictEqual(report.coverage, 1, '均匀达标场景：分桶口径与全局口径同判');
  assert.ok(report.coverage >= COVERAGE_THRESHOLD, '阈值口径未变（COVERAGE_THRESHOLD）');
});

test('S5 变异判据：单桶拥挤 ⇒ 全局口径放行而分桶口径阻断（去掉分桶即漏放）', async () => {
  const samples = [
    candidateOf('twist:a+b'),
    candidateOf('archive:r1'),
    candidateOf('archive:r2'),
    candidateOf('archive:r3'),
  ];
  const globalMeter = new RewardCoverageMeter();
  const globalReward = globalMeter.wrap({ verify: (c) => Promise.resolve(verdictBySource(c)) });
  const bucketMeter = new BucketedCoverageMeter();
  const bucketReward = bucketMeter.wrap({ verify: (c) => Promise.resolve(verdictBySource(c)) });
  for (const s of samples) {
    await globalReward(s);
    await bucketReward(s);
  }
  assert.strictEqual(globalMeter.report().coverage, 0.75);
  assert.ok(
    globalMeter.report().coverage >= COVERAGE_THRESHOLD,
    '全局口径（0.75 ≥ 0.6）：平均值把「twist 工况一次都没验过」掩盖掉',
  );
  assert.strictEqual(bucketMeter.report().coverage, 0, '分桶口径：最差桶 twist = 0');
  assert.ok(bucketMeter.report().coverage < COVERAGE_THRESHOLD, '最差桶低于阈值 ⇒ 闸必须拦');
});

test('S5 闸端到端：同一裁决流下，全局口径放行、分桶口径阻断（闸取最差桶，不是事后观测）', async () => {
  const samples = [
    candidateOf('twist:a+b'),
    candidateOf('archive:r1'),
    candidateOf('archive:r2'),
    candidateOf('archive:r3'),
  ];
  const run = async (
    meter: RewardCoverageMeter | BucketedCoverageMeter,
  ): Promise<{ promoted: boolean; reason: string }> => {
    const reward = meter.wrap({ verify: (c) => Promise.resolve(verdictBySource(c)) });
    for (const s of samples) await reward(s);
    const controller = new RlvrEvolutionController({
      inner: stubInner([promotedVerdict('s1')]),
      admission: new PromotionAdmission(),
      meter,
      minCoverage: COVERAGE_THRESHOLD,
    });
    const final = await controller.cycle();
    assert.strictEqual(controller.report()?.coverage, meter.report().coverage);
    return { promoted: final[0]!.promoted, reason: final[0]!.reason };
  };
  const global = await run(new RewardCoverageMeter());
  assert.strictEqual(global.promoted, true, '全局口径（0.75）放行 —— 这就是「去分桶」的漏放');
  const bucketed = await run(new BucketedCoverageMeter());
  assert.strictEqual(bucketed.promoted, false, '分桶口径（最差桶 0）阻断晋升');
  assert.match(bucketed.reason, /覆盖率闸否决晋升/);
  assert.match(bucketed.reason, /最差工况桶 twist/);
});

test('S5 探针只求值一次：分桶不让真实验证（spawn）多跑一次', async () => {
  const meter = new BucketedCoverageMeter();
  let calls = 0;
  const reward = meter.wrap({
    verify: (c) => {
      calls++;
      return Promise.resolve(verdictBySource(c));
    },
  });
  await reward(candidateOf('twist:a+b'));
  assert.strictEqual(calls, 1, '一次样本一次求值（全局与桶两处记账共用同一次结论）');
  assert.strictEqual(meter.report().global.samples, 1);
  assert.strictEqual(meter.report().buckets.length, 1);
});

test('S5 桶键派生：meta.source 算子前缀；无来源归 unknown；派生异常不影响奖励', async () => {
  assert.strictEqual(BucketedCoverageMeter.sourceBucket(candidateOf('twist:a+b')), 'twist');
  assert.strictEqual(BucketedCoverageMeter.sourceBucket(candidateOf('plain')), 'plain');
  assert.strictEqual(BucketedCoverageMeter.sourceBucket({ id: 's0' }), 'unknown');
  assert.strictEqual(BucketedCoverageMeter.sourceBucket(null), 'unknown');
  assert.strictEqual(BucketedCoverageMeter.sourceBucket(':weird'), 'unknown');

  const meter = new BucketedCoverageMeter({
    bucketFor: () => {
      throw new Error('派生炸了');
    },
  });
  const reward = meter.wrap({
    verify: () => Promise.resolve({ reward: 1, verifiable: true, reason: 'verified-pass' }),
  });
  assert.strictEqual(await reward(candidateOf('twist:a+b')), 1, '桶键派生失败不连累奖励');
  assert.strictEqual(
    meter.report().worstBucket,
    'unknown',
    '派生失败归 unknown 桶（不静默丢样本）',
  );
});

test('S5 装配级接线：createRlvrEvolutionController 开 bucketedCoverage 才换口径（缺省关 = 零破坏）', async () => {
  const model = { generate: async () => ({ text: '```js\nconst a = 1;\n```' }) };
  const candidate = {
    skill: { name: 'skill-a', description: '检索', instructions: '检索步骤。' },
    source: 'twist:a+b',
  };
  const discovery = {
    nextCandidates: () => [candidate],
    budgetUsed: () => ({ generated: 1, maxCandidates: 1 }),
  };
  const base = {
    skills: [candidate.skill],
    compose: (a: { name: string }) => a,
    model,
    discovery,
    gateBenchmark: () => 1,
    minGain: 0,
    verifyCommand: `"${process.execPath}" --check %CODE_FILE%`,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 1,
  };
  const off = RlvrController.createRlvrEvolutionController(base as never);
  await off.controller.cycle();
  assert.strictEqual(
    off.report()?.coverageWorstBucket,
    undefined,
    'bucketedCoverage 缺省关：报告不带桶口径字段（装配面与现状一致）',
  );
  const on = RlvrController.createRlvrEvolutionController({
    ...base,
    bucketedCoverage: true,
  } as never);
  await on.controller.cycle();
  assert.strictEqual(
    on.report()?.coverageWorstBucket,
    'twist',
    '开分桶 ⇒ 报告点名最差桶（工况来源经采样上下文流入 meta.source）',
  );
  assert.deepStrictEqual(on.report()?.coverageBuckets, [
    { bucket: 'twist', samples: 1, coverage: 1 },
  ]);
});
