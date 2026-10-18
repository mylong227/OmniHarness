#!/usr/bin/env node
/**
 * Laya verdict trace 校准探针（离线、确定性、无模型）。
 *
 * ## 回答什么问题
 *
 * 1. Laya 的 `noul` 预判到底有没有**区分力**（同一批源码写入里，测试通过的样本是否更高分）？
 * 2. 它的概率是否可当概率用（Brier 相对 base-rate 基线）？还是只能当序信号（AUC）？
 * 3. 当前 trace 量够不够支撑「把 shadow 升 enforce」或「扩展第二个决策点」？
 *
 * ## 口径
 *
 * 只读 `VerdictTracer` 落盘的配对 trace（`noul` + 真实 `testRan/testPassed`），不重跑模型、不重跑测试。
 * - Brier = mean((p - y)^2)，baseline = 用样本 base rate 做常数预测；
 * - AUC = Mann-Whitney 秩统计（正样本对负样本的胜率，0.5 = 无区分力）；
 * - lift = mean(p | pass) - mean(p | fail)；
 * - 校准桶按 [0,.2) … [0.8,1] 分组，打印每桶 count / 实际通过率 / 平均预判。
 *
 * ## 前置
 *
 * 有 `npm run build` 产物不是本探针的硬依赖（它只读 JSONL）；按本目录统一纪律仍提示先构建。
 * 需要至少 `--min` 条**同时有 noul 与真实 testPassed** 的样本；不足即退出码 3（仪器无区分力，
 * 不打印漂亮但无意义的数字）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/layaVerdictCalibration.mjs --dir=.omni-storage/laya-traces --min=20 --json=out.json
 * ```
 *
 * ## 诚实边界
 *
 * - trace 只覆盖“写源码后的自验证”一个决策点，**不能**外推到工具选择/规划；
 * - 样本有选择偏差：只有实际跑了测试且引擎可用的写入才落盘；
 * - AUC/Brier 只说明这批 trace 上的序/校准，不证明因果增益；上线 enforce 前仍应做 A/B。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeArgs } from './_args.mjs';

const args = probeArgs({ values: { dir: '', min: '20', json: '' } });
const dir = typeof args.dir === 'string' ? args.dir : '';
const min = Number.parseInt(typeof args.min === 'string' ? args.min : '20', 10);
if (dir === '') {
  console.error('✗ 需要 --dir=<trace 目录>（VerdictTracer 落盘的 .jsonl 目录）');
  process.exit(2);
}
if (!Number.isFinite(min) || min < 1) {
  console.error('✗ --min 必须是正整数');
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`✗ trace 目录不存在：${dir}（先运行带 decisionEngine shadow 的会话）`);
  process.exit(2);
}

/** @typedef {{ p: number, y: boolean }} Sample */
/** @type {Sample[]} */
const samples = [];
for (const name of readdirSync(dir)
  .filter((n) => n.endsWith('.jsonl'))
  .sort()) {
  const text = readFileSync(join(dir, name), 'utf8');
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.available !== true) continue;
    if (typeof row.noul !== 'number' || !Number.isFinite(row.noul)) continue;
    if (row.testRan !== true || typeof row.testPassed !== 'boolean') continue;
    samples.push({ p: Math.min(1, Math.max(0, row.noul)), y: row.testPassed });
  }
}

if (samples.length < min) {
  console.error(
    `✗ 有效配对样本不足：${String(samples.length)} < ${String(min)}（不足时不输出“看起来有结论”的数字）`,
  );
  process.exit(3);
}

const n = samples.length;
const positives = samples.filter((s) => s.y);
const negatives = samples.filter((s) => !s.y);
const baseRate = positives.length / n;
const brier = samples.reduce((sum, s) => sum + (s.p - (s.y ? 1 : 0)) ** 2, 0) / n;
const baselineBrier = baseRate * (1 - baseRate);
const meanPos =
  positives.length === 0 ? Number.NaN : positives.reduce((a, s) => a + s.p, 0) / positives.length;
const meanNeg =
  negatives.length === 0 ? Number.NaN : negatives.reduce((a, s) => a + s.p, 0) / negatives.length;
const lift = meanPos - meanNeg;

/**
 * Mann-Whitney AUC（正样本得分高于负样本的比例，ties 记 0.5）。
 * @param {readonly Sample[]} pos 正样本
 * @param {readonly Sample[]} neg 负样本
 * @returns {number} AUC（某一类为空时为 NaN）
 */
function auc(pos, neg) {
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) {
    for (const q of neg) {
      if (p.p > q.p) wins += 1;
      else if (p.p === q.p) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

const bins = [];
for (let i = 0; i < 5; i += 1) {
  const lo = i / 5;
  const hi = (i + 1) / 5;
  const inBin = samples.filter((s) => (i === 4 ? s.p >= lo && s.p <= hi : s.p >= lo && s.p < hi));
  if (inBin.length === 0) continue;
  bins.push({
    range: `[${lo.toFixed(1)},${hi.toFixed(1)}${i === 4 ? ']' : ')'}`,
    count: inBin.length,
    actualPassRate: inBin.filter((s) => s.y).length / inBin.length,
    meanPrediction: inBin.reduce((a, s) => a + s.p, 0) / inBin.length,
  });
}

const report = {
  probe: 'layaVerdictCalibration',
  dir,
  samples: n,
  positives: positives.length,
  negatives: negatives.length,
  baseRate,
  brier,
  baselineBrier,
  brierSkill: baselineBrier === 0 ? Number.NaN : 1 - brier / baselineBrier,
  auc: auc(positives, negatives),
  meanPredictionPass: meanPos,
  meanPredictionFail: meanNeg,
  lift,
  bins,
};
console.log(`Laya verdict 校准：${dir}`);
console.log(
  `样本 ${String(n)}（通过 ${String(positives.length)} / 失败 ${String(negatives.length)}）；baseRate=${baseRate.toFixed(3)}`,
);
console.log(
  `Brier=${brier.toFixed(4)}（baseline ${baselineBrier.toFixed(4)}，skill=${Number.isNaN(report.brierSkill) ? 'NA' : report.brierSkill.toFixed(3)}）｜AUC=${Number.isNaN(report.auc) ? 'NA' : report.auc.toFixed(3)}`,
);
console.log(
  `meanP(pass)=${Number.isNaN(meanPos) ? 'NA' : meanPos.toFixed(3)} ｜ meanP(fail)=${Number.isNaN(meanNeg) ? 'NA' : meanNeg.toFixed(3)} ｜ lift=${Number.isNaN(lift) ? 'NA' : lift.toFixed(3)}`,
);
for (const b of bins) {
  console.log(
    `  ${b.range.padEnd(10)} n=${String(b.count).padStart(4)} actual=${b.actualPassRate.toFixed(3)} meanP=${b.meanPrediction.toFixed(3)}`,
  );
}
const json = typeof args.json === 'string' ? args.json : '';
if (json !== '') writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
