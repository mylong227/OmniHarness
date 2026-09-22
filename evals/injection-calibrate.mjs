#!/usr/bin/env node
// 护栏「来源分级阈值」校准 harness（L3）——把**手设常数**放回数据上检验。
//
// 动机（借鉴来源见 docs/TASK_BOARD.md §17.2 L3）：Laya 的实测教训是——**校准必须按
// （题型 × 选项数）分别拟合**，且出厂权重一律过度自信（raw ECE 0.466 → 拟合后才 0.081）。
// 本仓库 `ToolOutputTrust.THRESHOLDS` 的四个阈值（external=1 / unknown=1 / file=2 / local=3）
// 是**手设的、从未在任何数据上标定过**的常数，正属同一形态。
//
// 做法：**不改 src**。`scanForInjection` 无论传入哪一档 tier 都会收全量 `hits`（tier 只影响
// `blocked` 的阈值判定），故可一次性取证、再对任意候选阈值向量离线重算。
//
// 三件事：
//   ① **复算一致性**：候选向量取「当前手设值」时，逐例判决必须与 `scanForInjection` 原生
//      `blocked` **完全一致** —— 否则说明本 harness 的复算逻辑与生产不同源，结论作废；
//   ② **敏感性**：逐档单独扫 1..4（其余档固定在当前值），看 recall / FP 如何随该档变动；
//   ③ **网格**：全 4^4=256 个向量里按 accuracy 与（recall 优先、FP 次之）各取最优，标出当前手设值的位置。
//
// 用法（免网络）：npm run build && node evals/injection-calibrate.mjs
// 输出：evals/injection-calibrate.report.json + 控制台摘要。
//
// 口径诚实声明（**必读，别把本报告当选型结论**）：
//   本快照共 32 例（恶意 20 / 良性 12），**每档样本仅个位数**（external 5 / file 4 / local 7 / unknown 16，
//   其中 file 档恶意样本仅 2 例）。用这个量级去「选最优阈值」在统计上不成立——本工具的作用是
//   **证明现有手设值的敏感性、并暴露哪些档位样本不足**，而**不是**给出生产阈值。
//   真正的选型需要 T4.4 的 AgentDojo/InjecAgent 真基准（需联网 + 数据集，D4 禁入主门禁，仍挂起）。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist', 'src');
const { scanForInjection } = await import(
  pathToFileURL(join(DIST, 'security', 'promptInjectionGuard.js')).href
);
const { ToolOutputTrust } = await import(
  pathToFileURL(join(DIST, 'security', 'toolOutputTrust.js')).href
);

/** 四档信任级（与 `ToolOutputTrust` 同源）。 */
const TIERS = ['external', 'unknown', 'file', 'local'];

/** 当前手设阈值（读自生产实现，不在此硬编码——防与实现漂移）。 */
const CURRENT = Object.fromEntries(TIERS.map((t) => [t, ToolOutputTrust.weakEvidenceThreshold(t)]));

const snapshot = JSON.parse(
  readFileSync(join(here, 'fixtures', 'injection-snapshot.json'), 'utf8'),
);
const cases = snapshot.cases;

/** 逐例取证：一趟扫描拿全量 hits，之后对任意阈值离线复算。 */
const evidence = cases.map((c) => {
  const tier = c.source ?? 'unknown';
  const scan = scanForInjection(c.text, tier);
  return {
    id: c.id,
    malicious: c.label === 'malicious',
    tier,
    strong: scan.hits.filter((h) => h.severity === 'strong').length,
    weak: scan.hits.filter((h) => h.severity === 'weak').length,
    blocked: scan.blocked,
  };
});

/**
 * 按给定阈值向量重算混淆矩阵。
 * @param thresholds 每档的弱证据阈值。
 * @returns 混淆矩阵与派生比率。
 */
function evaluate(thresholds) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const e of evidence) {
    const blocked = e.strong > 0 || e.weak >= thresholds[e.tier];
    if (e.malicious) blocked ? tp++ : fn++;
    else blocked ? fp++ : tn++;
  }
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const fpRate = fp + tn === 0 ? 0 : fp / (fp + tn);
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const accuracy = (tp + tn) / evidence.length;
  return { tp, fp, tn, fn, recall, fpRate, precision, accuracy };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

// —— ① 复算一致性：候选=当前手设值时，必须与生产原生判决逐例一致 ——
let agree = 0;
for (const e of evidence) {
  const blocked = e.strong > 0 || e.weak >= CURRENT[e.tier];
  if (blocked === e.blocked) agree++;
}
const consistent = agree === evidence.length;

const lines = [];
lines.push('=== 护栏来源分级阈值校准（L3；不改 src，离线复算）===');
lines.push(`快照: ${snapshot.source}`);
lines.push(
  `用例: ${evidence.length}（恶意 ${evidence.filter((e) => e.malicious).length} / 良性 ${evidence.filter((e) => !e.malicious).length}）`,
);
lines.push(`当前手设阈值: ${TIERS.map((t) => `${t}=${CURRENT[t]}`).join('  ')}`);
lines.push(
  `① 复算一致性（候选=手设值 vs 生产原生 blocked）: ${agree}/${evidence.length}${consistent ? '  ✅ 同源' : '  ❌ 不同源，结论作废'}`,
);
if (!consistent) {
  process.stderr.write('复算与生产不同源，中止。\n');
  process.exit(1);
}

const current = evaluate(CURRENT);
lines.push(
  `   当前档位表现: recall=${pct(current.recall)} FP=${pct(current.fpRate)} precision=${pct(current.precision)} accuracy=${pct(current.accuracy)}`,
);

// —— ② 逐档敏感性：单独扫该档 1..4，其余固定在当前值 ——
lines.push('');
lines.push('--- ② 逐档敏感性（只动该档，其余固定当前值）---');
const sensitivity = {};
for (const tier of TIERS) {
  const rows = [];
  for (let v = 1; v <= 4; v++) {
    const m = evaluate({ ...CURRENT, [tier]: v });
    rows.push({
      threshold: v,
      recall: +m.recall.toFixed(4),
      fpRate: +m.fpRate.toFixed(4),
      accuracy: +m.accuracy.toFixed(4),
    });
  }
  sensitivity[tier] = rows;
  const cur = rows.find((r) => r.threshold === CURRENT[tier]);
  lines.push(
    `  ${tier.padEnd(9)} 当前=${CURRENT[tier]}  ` +
      rows.map((r) => `${r.threshold}:${pct(r.recall)}/${pct(r.fpRate)}`).join('  ') +
      `   （读作 recall/FP）`,
  );
  // 逐档样本量：恶意样本为 0 的档位，其阈值在数学上不可辨识。
  const mal = evidence.filter((e) => e.malicious && e.tier === tier).length;
  const ben = evidence.filter((e) => !e.malicious && e.tier === tier).length;
  lines.push(
    `            样本: 恶意 ${mal} / 良性 ${ben}${mal === 0 ? '  ⚠️ 恶意样本为 0 ⇒ 该档阈值不可辨识' : ''}`,
  );
  if (cur === undefined) lines.push('            （当前值不在扫描范围）');
}

// —— ③ 网格：全向量里取最优，并标出当前手设值位置 ——
lines.push('');
lines.push('--- ③ 全网格（4^4=256）---');
const all = [];
for (const a of [1, 2, 3, 4])
  for (const b of [1, 2, 3, 4])
    for (const c of [1, 2, 3, 4])
      for (const d of [1, 2, 3, 4]) {
        const T = { external: a, unknown: b, file: c, local: d };
        all.push({ T, ...evaluate(T) });
      }
const key = (T) => TIERS.map((t) => T[t]).join(',');
all.sort((x, y) => y.accuracy - x.accuracy || y.recall - x.recall || x.fpRate - y.fpRate);
const bestAccuracy = all[0];
const bestRecallThenFp = [...all].sort(
  (x, y) => y.recall - x.recall || x.fpRate - y.fpRate || y.accuracy - x.accuracy,
)[0];
const curRow = all.find((r) => key(r.T) === key(CURRENT));
const rankByAccuracy = all.findIndex((r) => key(r.T) === key(CURRENT)) + 1;
lines.push(
  `  最高 accuracy: ${key(bestAccuracy.T)}  recall=${pct(bestAccuracy.recall)} FP=${pct(bestAccuracy.fpRate)} acc=${pct(bestAccuracy.accuracy)}`,
);
lines.push(
  `  最高 recall（并列取 FP 低）: ${key(bestRecallThenFp.T)}  recall=${pct(bestRecallThenFp.recall)} FP=${pct(bestRecallThenFp.fpRate)} acc=${pct(bestRecallThenFp.accuracy)}`,
);
lines.push(
  `  当前手设值:   ${key(CURRENT)}  recall=${pct(current.recall)} FP=${pct(current.fpRate)} acc=${pct(current.accuracy)}  （按 accuracy 排名 ${rankByAccuracy}/${all.length}）`,
);
const ties = all.filter((r) => r.accuracy === bestAccuracy.accuracy).length;
lines.push(`  （accuracy 最高者共 ${ties} 个向量并列 ⇒ 本样本量下**多解**，进一步说明不足以选型）`);

lines.push('');
lines.push('⚠️ 口径：n=32、每档个位数样本 ⇒ 本报告只用于「证明手设值的敏感性 + 暴露缺样本档位」，');
lines.push('   **不可**当作生产阈值选型结论；真选型需 T4.4（AgentDojo/InjecAgent）真基准。');
process.stdout.write(lines.join('\n') + '\n');

const report = {
  generatedAt: new Date().toISOString(),
  snapshot: snapshot.source,
  cases: evidence.length,
  currentThresholds: CURRENT,
  consistency: { agree, total: evidence.length, sameSource: consistent },
  current: current,
  sensitivity,
  grid: {
    total: all.length,
    bestByAccuracy: { thresholds: bestAccuracy.T, ...bestAccuracy },
    bestByRecallThenFp: { thresholds: bestRecallThenFp.T, ...bestRecallThenFp },
    currentRankByAccuracy: rankByAccuracy,
    accuracyTies: ties,
  },
  caveat:
    'n=32、每档个位数样本：仅用于证明手设阈值敏感性与暴露缺样本档位，不可作为生产阈值选型结论。',
};

let reportText = `${JSON.stringify(report, null, 2)}\n`;
try {
  const prettier = await import('prettier');
  reportText = await prettier.format(JSON.stringify(report), { parser: 'json' });
} catch {
  console.warn('  ⚠️ 未找到 Prettier，报告以 stringify 落盘；format:check 可能报此文件');
}
writeFileSync(join(here, 'injection-calibrate.report.json'), reportText);
process.stdout.write('Wrote evals/injection-calibrate.report.json\n');
