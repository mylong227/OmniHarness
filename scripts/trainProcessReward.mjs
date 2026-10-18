#!/usr/bin/env node
/**
 * P3 标准 PRM 训练/评测管线（判别式基线；不是 GenPRM）。
 *
 * 输入：`ProcessRewardStore` 落盘的步骤级 JSONL（每行一个 StepRewardSample）。
 * 输出：控制台指标 + 可选模型 JSON（`logistic-prm-v1`）。
 *
 * 纪律：按 sessionId 分组切分（无泄漏）；测试集只报告，不参与训练；样本不足/单一类别 fail-closed。
 *
 * 用法：
 *   npm run build
 *   node scripts/trainProcessReward.mjs --input=.omniharness/step-rewards.jsonl --out=.omniharness/prm-model.json
 *
 * 诚实边界：这是判别式 logistic PRM 基线，不是生成式 GenPRM；它只校准/组合步骤特征，
 * 不能替代真实测试，也不能仅凭本脚本声称任务成功率提升。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 解析 `--name=value`（严格；未知/空格形式直接退出 2）。 */
function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  if (hit !== undefined) return hit.slice(prefix.length);
  if (process.argv.some((value) => value === `--${name}`)) {
    console.error(`✗ 旗标 --${name} 必须写成 --${name}=<value>（空格形式会静默失效）`);
    process.exit(2);
  }
  return fallback;
}

const input = arg('input', '');
const output = arg('out', '');
const seed = Number(arg('seed', '7'));
const epochs = Number(arg('epochs', '400'));
if (input === '') {
  console.error('✗ 需要 --input=<step-rewards.jsonl>');
  process.exit(2);
}
if (!existsSync(input)) {
  console.error(`✗ 输入不存在：${input}`);
  process.exit(3);
}
if (!existsSync(resolve('dist/src/evolution/processRewardDataset.js'))) {
  console.error('✗ 缺少编译产物：先运行 npm run build');
  process.exit(2);
}
if (!Number.isFinite(seed) || !Number.isFinite(epochs) || epochs < 1) {
  console.error('✗ --seed/--epochs 必须是有效数字');
  process.exit(2);
}

const { ProcessRewardDataset } = await import('../dist/src/evolution/processRewardDataset.js');
const { LogisticProcessReward } = await import('../dist/src/evolution/logisticProcessReward.js');

const samples = readFileSync(input, 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));
const split = ProcessRewardDataset.split(samples, { seed });
if (split.train.length < 10) {
  console.error(`✗ 训练样本不足：${String(split.train.length)} < 10（先积累真实步骤样本）`);
  process.exit(3);
}
let model;
try {
  model = LogisticProcessReward.train(split.train, split.val, { epochs });
} catch (error) {
  console.error(`✗ 训练失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}
const trainMetrics = model.evaluate(split.train);
const valMetrics = model.evaluate(split.val);
const testMetrics = model.evaluate(split.test);
const baseline = noulMetrics(split.test);
console.log(
  `[PRM] split train=${String(split.train.length)} val=${String(split.val.length)} test=${String(split.test.length)}`,
);
for (const [name, metrics] of [
  ['train', trainMetrics],
  ['val', valMetrics],
  ['test', testMetrics],
]) {
  console.log(
    `[PRM] ${name}: n=${String(metrics.samples)} AUC=${Number.isNaN(metrics.auc) ? 'NA' : metrics.auc.toFixed(3)} Brier=${Number.isNaN(metrics.brier) ? 'NA' : metrics.brier.toFixed(4)} acc=${Number.isNaN(metrics.accuracy) ? 'NA' : metrics.accuracy.toFixed(3)}`,
  );
}
console.log(
  `[PRM] test baseline(noul only): n=${String(baseline.samples)} AUC=${Number.isNaN(baseline.auc) ? 'NA' : baseline.auc.toFixed(3)} Brier=${Number.isNaN(baseline.brier) ? 'NA' : baseline.brier.toFixed(4)}；PRM ΔAUC=${Number.isNaN(baseline.auc) || Number.isNaN(testMetrics.auc) ? 'NA' : (testMetrics.auc - baseline.auc).toFixed(3)}`,
);

/** 只用 noul 的基线（AUC/Brier）。 */
function noulMetrics(samples) {
  const rows = samples.filter((sample) => Number.isFinite(sample.noul));
  if (rows.length === 0) return { samples: 0, auc: Number.NaN, brier: Number.NaN };
  const positives = rows.filter((sample) => sample.passed === true).map((sample) => sample.noul);
  const negatives = rows.filter((sample) => sample.passed !== true).map((sample) => sample.noul);
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  const auc =
    positives.length === 0 || negatives.length === 0
      ? Number.NaN
      : wins / (positives.length * negatives.length);
  const brier =
    rows.reduce((sum, sample) => sum + (sample.noul - (sample.passed ? 1 : 0)) ** 2, 0) /
    rows.length;
  return { samples: rows.length, auc, brier };
}

if (output !== '') {
  writeFileSync(output, `${JSON.stringify(model.toJson(), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  console.log(`[PRM] 模型写入 ${output}`);
}
