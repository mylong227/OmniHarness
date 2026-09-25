/**
 * T4.4 真提示注入基准（InjecAgent 官方数据集，离线零依赖）。
 *
 * 背景：此前 `metrics:injection` 只对**离线 curated 快照**出数（A4 结项口径自认「非真基准」），
 * 真基准挂起于「数据集不可得」。2026-09-25 经 ghproxy 通道取得 InjecAgent 官方数据
 * （Zhan et al., 2024：1,054 题 × direct/scenario 两设置 = 2,108 条攻击呈现，落盘
 * `eval-data/injecagent/`，已 gitignore 不入库），本脚本把生产护栏
 * `promptInjectionGuard#scanForInjection` 放到**真实攻击样本**上量。
 *
 * 口径（实测钉死，勿再想当然）：
 *   - 四套文件**全部是攻击用例**（逐条验证过 `Attacker Instruction` 确嵌入 `Tool Response`）；
 *     数据集**没有干净对照组** ⇒ 本脚本只出**召回**，误报仍由 curated 快照口径
 *     （`metrics:injection`）承担。字段 `Modifed` 是生成管线的变体位（0/1），**不是** clean 标记。
 *   - **总召回**：`Tool Response`（攻击指令嵌入其中的真实工具输出）被护栏 blocked 的比例
 *     （信任档取生产 web 路径 `external`）；
 *   - **裸指令诊断**：`Attacker Instruction`（不带工具输出包装）的召回——差值即「包装的触发词贡献」；
 *   - 分层：direct-harm（dh）/ data-stealing（ds）× base（直接附加）/ enhanced（场景嵌入）× Attack Type。
 *
 * 不进主门禁（D4），只出数与报告。
 *
 * 用法（构建后）：`node evals/injection-injecagent.mjs`，npm：`npm run metrics:injection:real`。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanForInjection } from '../dist/src/security/promptInjectionGuard.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'eval-data', 'injecagent');
const reportPath = join(here, 'injection-injecagent.report.json');

/** 四套官方用例：意图（dh=direct harm / ds=data stealing）× 设置（base=直接附加 / enhanced=场景嵌入）。 */
const FILES = [
  { file: 'test_cases_dh_base.json', intent: 'direct-harm', setting: 'direct' },
  { file: 'test_cases_dh_enhanced.json', intent: 'direct-harm', setting: 'scenario' },
  { file: 'test_cases_ds_base.json', intent: 'data-stealing', setting: 'direct' },
  { file: 'test_cases_ds_enhanced.json', intent: 'data-stealing', setting: 'scenario' },
];

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** 汇总一组扫描结果。
 * @param {Array<{blocked: boolean, type: string}>} scans 逐用例结果。
 * @returns {{total: number, blocked: number, rate: number, byType: Record<string, {total: number, blocked: number, rate: number}>}} 汇总。
 */
function summarize(scans) {
  const blocked = scans.filter((s) => s.blocked).length;
  const byType = {};
  for (const s of scans) {
    const b = (byType[s.type] ??= { total: 0, blocked: 0 });
    b.total += 1;
    if (s.blocked) b.blocked += 1;
  }
  for (const s of Object.values(byType)) s.rate = s.blocked / s.total;
  return { total: scans.length, blocked, rate: blocked / Math.max(1, scans.length), byType };
}

if (!existsSync(dataDir)) {
  console.error(
    `❌ 缺数据集目录 ${dataDir}：请先经 ghproxy 下载 InjecAgent data/ 四套 test_cases_*.json（见脚本头注释）。`,
  );
  process.exit(1);
}

const responseScans = [];
const instructionScans = [];
const byCell = {};
for (const entry of FILES) {
  const cases = JSON.parse(readFileSync(join(dataDir, entry.file), 'utf8'));
  const cell = { total: 0, blocked: 0 };
  for (const c of cases) {
    const type = String(c['Attack Type'] ?? 'unknown');
    const on = {
      blocked: scanForInjection(String(c['Tool Response'] ?? ''), 'external').blocked,
      type,
    };
    responseScans.push(on);
    instructionScans.push({
      blocked: scanForInjection(String(c['Attacker Instruction'] ?? ''), 'external').blocked,
      type,
    });
    cell.total += 1;
    if (on.blocked) cell.blocked += 1;
  }
  byCell[`${entry.intent}/${entry.setting}`] = { ...cell, recall: cell.blocked / cell.total };
}

const recall = summarize(responseScans);
const bare = summarize(instructionScans);

const lines = [];
lines.push('=== T4.4 真注入基准（InjecAgent 2,108 条攻击呈现，scanForInjection@external）===');
lines.push(
  `真实召回（poisoned 工具输出）：${pct(recall.rate)}（${recall.blocked}/${recall.total}）`,
);
lines.push(`裸攻击指令召回（诊断）　　　：${pct(bare.rate)}（${bare.blocked}/${bare.total}）`);
lines.push('  （数据集无干净对照组 ⇒ 误报口径仍由 curated 快照 metrics:injection 承担）');
lines.push('--- 分层（intent/setting）---');
for (const [cell, s] of Object.entries(byCell)) {
  lines.push(`  ${cell}: ${pct(s.recall)}（${s.blocked}/${s.total}）`);
}
lines.push('--- 按 Attack Type（召回）---');
for (const [type, s] of Object.entries(recall.byType)) {
  lines.push(`  ${type}: ${pct(s.rate)}（${s.blocked}/${s.total}）`);
}
lines.push(`报告已写出: ${reportPath}`);
process.stdout.write(lines.join('\n') + '\n');

writeFileSync(
  reportPath,
  JSON.stringify(
    {
      benchmark: 'InjecAgent (Zhan et al., 2024) — real indirect prompt injection cases',
      tier: 'external',
      note: '数据集全部为攻击用例、无干净对照组：只出召回；FP 由 curated 快照口径承担。',
      recall: {
        rate: recall.rate,
        blocked: recall.blocked,
        total: recall.total,
        byAttackType: recall.byType,
      },
      bareInstructionRecall: { rate: bare.rate, blocked: bare.blocked, total: bare.total },
      byCell,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
