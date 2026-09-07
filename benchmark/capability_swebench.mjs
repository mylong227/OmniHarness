// capability_swebench.mjs —— SWE-bench 风格能力基准（自包含、可离线、零 key 可跑）
//
// 目的：把报告 #20 的 P3 诚实缺口（"OmniHarness 尚未跑 SWE-bench，能力分数维度暂无
// apples-to-apples 对照"）变成可机械验证的能力基线框架。
//
// 两套件同跑：
//   1) 确定性基建套件（mode=scripted）：用 ScriptedModel replay 修复步骤，证明
//      「读文件 → 应用补丁 → 跑测试 → 评分」真实链路在 OmniHarness 内可用（零 API Key）。
//   2) 对照（gold/negative）：阳性对照直接套 goldPatch 必过（评分器不假阴），
//      阴性对照仅 seed 不修复必不过（评分器不假阳）。二者全有效能力分数才成立。
//
// 真实 LLM 能力分数（mode=live）：需在 DEEPSEEK_API_KEY 可用时显式 `--live` 开启，
// 经 OpenAiCompatibleModel + BudgetedModel 成本护栏跑同一套件。默认不跑，避免无提示烧钱。
//
// 任务定义复用 benchmark/swebenchTasks.mjs（与 evals/live/bench.mjs --swebench 共享，避免重复）。
//
// 用法：
//   node benchmark/capability_swebench.mjs                 # 基建套件 + 对照（零 key，约数秒）
//   DEEPSEEK_API_KEY=sk-xxx node benchmark/capability_swebench.mjs --live   # 真实能力分数
//
// 输出：benchmark/capability-swebench.json（基建 + 对照 + 可选 live）+ 控制台报告。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runSweSuite, runControls, formatSweReport } from '../dist/src/eval/swebench.js';
import { ScriptedModel } from '../dist/src/eval/scriptedModel.js';
import { SWEBENCH_LITE_TASKS, buildEnhancedTasks } from './swebenchTasks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'capability-swebench.json');

// 增强提示：要求用 read_file + apply_patch 工具完成修复（规范 agent 工具使用，不泄露答案）。
// 这是合理的 agent 引导（对标成熟 agent 的 system 指令），仅规范工具使用方式。
const ENHANCED_TASKS = buildEnhancedTasks(SWEBENCH_LITE_TASKS);

const scriptedModelFor = (task) => new ScriptedModel(task.script ?? [], '任务完成（swebench）');

const scripted = await runSweSuite('capability-scripted', ENHANCED_TASKS, null, 'scripted', {
  modelFor: scriptedModelFor,
});
const controls = await runControls(ENHANCED_TASKS);

const report = {
  suite: 'capability-swebench',
  generatedAt: new Date().toISOString(),
  scripted: {
    passed: scripted.passed,
    total: scripted.total,
    results: scripted.results,
    totalDurationMs: scripted.totalDurationMs,
  },
  controls: {
    valid: controls.valid,
    gold: controls.gold,
    negative: controls.negative,
  },
  live: null,
};

// 真实 LLM 能力分数（需 key + 显式 --live）
const live = process.argv.includes('--live');
if (live) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('[capability:swebench] --live 需要 DEEPSEEK_API_KEY，未提供，跳过 live。');
  } else {
    const { OpenAiCompatibleModel } =
      await import('../dist/src/adapters/model/openaiCompatibleModel.js');
    const { BudgetedModel } = await import('../dist/src/adapters/model/budgetedModel.js');
    const { CostBudget } = await import('../dist/src/adapters/model/costBudget.js');
    const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    const budget = new CostBudget(0.5, new Map());
    const liveModel = new BudgetedModel(
      new OpenAiCompatibleModel({ baseUrl, apiKey, model: modelName }),
      budget,
    );
    console.log(`[capability:swebench] live 模式：用 ${modelName} @ ${baseUrl}（预算 $0.50 护栏）`);
    const liveReport = await runSweSuite('capability-live', ENHANCED_TASKS, liveModel, 'live');
    report.live = {
      model: modelName,
      passed: liveReport.passed,
      total: liveReport.total,
      results: liveReport.results,
      totalDurationMs: liveReport.totalDurationMs,
      costUsd: Number(budget.totalCostUsd.toFixed(4)),
    };
  }
}

writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

// ---------- 控制台 ----------
console.log(formatSweReport(scripted, controls));
if (report.live !== null) {
  console.log(
    `=== LIVE 能力分数: ${report.live.passed}/${report.live.total} 通过, 花费 $${report.live.costUsd} ===`,
  );
}
console.log(
  `\n[capability:swebench] 基建套件 ${scripted.passed}/${scripted.total} 通过；对照有效性=${controls.valid}`,
);
console.log(`[capability:swebench] 报告已写入: ${OUT}`);
if (!controls.valid) {
  console.error('[capability:swebench] ❌ 对照失效：能力分数不可信，请检查任务定义/评分器。');
  process.exit(1);
}
