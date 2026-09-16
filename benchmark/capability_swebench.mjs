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

import { readFileSync, writeFileSync } from 'node:fs';
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

// ---------- 官方 SWE-bench Verified 子集（B1 官方跑分真实接线，免 Docker、免云）----------
// 原生本地执行器（git worktree 检出 + uv venv + 应用补丁 + pytest 判定），零 Docker、零云。
// 用法（执行须在你侧具备 git + uv + 网络 的环境）：
//   node benchmark/capability_swebench.mjs --verified <swe_bench_verified.json> \
//     --predictions <preds.jsonl> [--concurrency N] \
//     [--repo-base https://gitee.com/] [--repo-mirrors benchmark/swebench-gitee-mirrors.json] \
//     [--env-pins benchmark/swebench-env-pins.json]
// 模型补丁（predictions）由我们的 live agent 在具备 git+uv+网络的环境生成；本命令只负责"打分"。
// 镜像通道：`--repo-base` + `--repo-mirrors` 用于把克隆重定向到国内镜像（上游 slug → 镜像 slug），
//   实测 Gitee 覆盖 12 个 SWE-bench 仓库中的 11 个、且 base_commit 全部命中（见镜像映射文件注释）。
//   两参数缺省时零行为变更（直连 https://github.com/，无重定向）。
// 环境约束：`--env-pins` 按仓库补 pip 约束（如 flask 的 Werkzeug<3），修复「不设上界的开发期运行时
//   依赖被解析到过新主版本」导致老测试套件崩的保真度缺口。缺省时零行为变更。
// 保真度边界：env 由 repo 自述 + uv 重建，不等同官方 Docker 镜像；用于本地迭代/小批量自测。
const verifiedIdx = process.argv.indexOf('--verified');
if (verifiedIdx !== -1) {
  const verifiedPath = process.argv[verifiedIdx + 1];
  const predsIdx = process.argv.indexOf('--predictions');
  const predsPath = predsIdx !== -1 ? process.argv[predsIdx + 1] : undefined;
  const concIdx = process.argv.indexOf('--concurrency');
  const concurrency = concIdx !== -1 ? Number(process.argv[concIdx + 1]) : 1;
  const baseIdx = process.argv.indexOf('--repo-base');
  const repoBaseUrl = baseIdx !== -1 ? process.argv[baseIdx + 1] : undefined;
  const mirrorIdx = process.argv.indexOf('--repo-mirrors');
  const mirrorPath = mirrorIdx !== -1 ? process.argv[mirrorIdx + 1] : undefined;
  const pinsIdx = process.argv.indexOf('--env-pins');
  const pinsPath = pinsIdx !== -1 ? process.argv[pinsIdx + 1] : undefined;
  // 镜像映射为可选：未给则在执行器内保持空映射 ⇒ 克隆 URL 与历史完全一致（零行为变更）。
  let repoMirrors = {};
  if (mirrorPath !== undefined) {
    const parsed = JSON.parse(readFileSync(mirrorPath, 'utf8'));
    repoMirrors = parsed.mirrors ?? {};
    console.log(
      `[capability:swebench:verified] 镜像映射 ${Object.keys(repoMirrors).length} 条（${mirrorPath}）`,
    );
  }
  // 环境约束为可选：未给则保持空映射 ⇒ 安装阶梯与历史一致（零行为变更）。
  let envPins = {};
  if (pinsPath !== undefined) {
    const parsed = JSON.parse(readFileSync(pinsPath, 'utf8'));
    envPins = parsed.pins ?? {};
    console.log(
      `[capability:swebench:verified] 环境约束 ${Object.keys(envPins).length} 条（${pinsPath}）`,
    );
  }

  const { SwebenchVerified } = await import('../dist/src/eval/swebenchVerified.js');
  const { NativeExecutor } = await import('../dist/src/eval/nativeExecutor.js');
  const executor = new NativeExecutor({
    repoCacheRoot: join(__dirname, '..', 'eval-data', 'repos'),
    ...(repoBaseUrl !== undefined ? { repoBaseUrl } : {}),
    ...(Object.keys(repoMirrors).length > 0 ? { repoMirrors } : {}),
    ...(Object.keys(envPins).length > 0 ? { envPins } : {}),
  });

  console.log(`[capability:swebench:verified] backend=native executor=${executor.describe()}`);
  const tasks = SwebenchVerified.loadVerified(verifiedPath);
  console.log(`[capability:swebench:verified] 加载 ${tasks.length} 个官方 Verified 实例`);

  if (predsPath === undefined) {
    console.error(
      '[capability:swebench:verified] ❌ 缺 --predictions：官方 Verified 需先由我们的 live agent 在具备 git+uv+网络的环境生成模型补丁（predictions.jsonl）。' +
        ' 本命令只负责"打分"一环（fail-closed）。',
    );
    process.exit(1);
  }
  const predictions = new Map();
  for (const line of readFileSync(predsPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    const obj = JSON.parse(t);
    if (typeof obj.instance_id === 'string' && typeof obj.model_patch === 'string') {
      predictions.set(obj.instance_id, obj.model_patch);
    }
  }
  console.log(`[capability:swebench:verified] 载入 ${predictions.size} 条预测`);

  const report = await SwebenchVerified.runVerifiedSuite(tasks, predictions, executor, concurrency);
  const outPath = join(__dirname, 'capability-swebench-verified.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(SwebenchVerified.formatVerifiedReport(report));
  console.log(`[capability:swebench:verified] 报告已写入: ${outPath}`);
  // 真实结果：即便有未通过也是有效分数（非 fail-closed），以 0 退出；仅当后端设施缺失导致全 fail 时由 executor 原因体现。
  process.exit(0);
}

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
