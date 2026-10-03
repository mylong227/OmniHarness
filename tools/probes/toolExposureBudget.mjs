#!/usr/bin/env node
/**
 * 工具暴露规划探针（G21 提升入库，2026-10-03；**离线、免网络、免模型、确定性**）。
 *
 * ## 回答什么问题
 *
 * 报告 §3.4 的实证是「工具 schema 预算是真实成本（Anthropic 一手：Claude Code 默认把工具响应限在
 * 25,000 token；playwright-mcp 自述编码 agent 正转向 CLI+SKILL 以避免大 schema 入库）」。本仓的
 * 处方是 `ToolExposurePlanner`：按任务文本命中的类别把工具**降为延迟加载**（可经 `tool_search` 找回）。
 * 本探针量的是这件事的**直接效果**：不同模式下**直载给模型的工具数**。
 *
 * ## 口径（诚实边界，别读成"省了多少 token"）
 *
 * - 输入是**工具名**（`src/ports/tool/toolNames.ts` 的单一来源）：规划器只看名字与类别表，看不到 schema；
 * - 故本探针输出**可见工具数**，**不是** schema token 数。要 token 数需接真实 schema（登记为后续项）；
 * - 工具数与 schema token 近似成正比（每个工具一份固定形状的 JSON schema）⇒ 工具数是可用的**代理量**，
 *   但**本探针不声称**具体 token 节省比例；
 * - `off` 模式 = 不干预（全部可见），`plan` 模式 = 按类别规划（本仓 `OMNI_TOOL_EXPOSURE=plan` 启用）。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/toolExposureBudget.mjs
 * node tools/probes/toolExposureBudget.mjs --task="修一下沙箱审批的回归测试" --json=out.json
 * ```
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

/**
 * 读命令行 `--name=value`。
 * @param {string} name 参数名（不含 `--`）。
 * @param {string} dflt 缺省值。
 * @returns {string} 值。
 */
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}

let ToolExposurePlanner;
let TOOL_NAMES;
try {
  ({ ToolExposurePlanner } = await importDist('core', 'toolExposurePlanner.js'));
  ({ TOOL_NAMES } = await importDist('ports', 'tool', 'toolNames.js'));
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

/** 全部工具名（单一来源表的值；去重后排序，保证确定性）。 */
const ALL_TOOLS = [...new Set(Object.values(TOOL_NAMES))].sort();

/**
 * 代表性任务文本（覆盖不同类别；也支持 `--task=` 只跑一条）。
 *
 * 为什么用这组：它们分别指向文件读写 / 检索 / 记忆 / 沙箱审批 / 子智能体 / 计划等不同类别，
 * 用于观察"任务文本命中类别 ⇒ 其余工具被降级"的覆盖面（含**不命中任何类别**的对照：应全放行）。
 */
const TASKS = [
  '读一下 src/core/container.ts 并解释依赖注入',
  '搜索仓库里所有的 memoize 实现',
  '把这次会话的结论记进长期记忆',
  '沙箱审批为什么被拒了',
  '开一个子智能体帮我跑测试',
  '这个任务太复杂了，先做个计划',
  '用 git status 看看当前改动',
  '把这段数学推导整理成公式',
];

/**
 * 规划一次并汇总。
 * @param {string} taskText 任务文本。
 * @returns {{task: string, visible: number, deferred: number, matched: readonly string[], ratio: number, reason: string}} 结果。
 */
function planOf(taskText) {
  const plan = ToolExposurePlanner.plan({ taskText, tools: ALL_TOOLS });
  return {
    task: taskText,
    visible: plan.visible.length,
    deferred: plan.deferred.length,
    matched: plan.matchedCategories,
    ratio: ALL_TOOLS.length === 0 ? 0 : plan.visible.length / ALL_TOOLS.length,
    reason: plan.reason,
  };
}

const only = arg('task', '');
const rows = (only === '' ? TASKS : [only]).map((task) => planOf(task));
const report = {
  probe: 'toolExposureBudget',
  measures: 'visibleToolCount（不是 schema token 数，见文件头口径）',
  totalTools: ALL_TOOLS.length,
  offMode: { visible: ALL_TOOLS.length, note: 'off 模式不干预 ⇒ 全部可见' },
  planMode: {
    rows,
    avgVisible: rows.reduce((s, r) => s + r.visible, 0) / rows.length,
    maxVisible: Math.max(...rows.map((r) => r.visible)),
    minVisible: Math.min(...rows.map((r) => r.visible)),
  },
};

console.log(
  `工具总数 ${ALL_TOOLS.length} ｜ off 模式可见 ${ALL_TOOLS.length} ｜ plan 模式（${rows.length} 条任务）\n`,
);
for (const row of rows) {
  console.log(
    `  visible=${String(row.visible).padStart(3)}/${ALL_TOOLS.length} 降级=${String(row.deferred).padStart(3)}` +
      ` 类别=[${row.matched.join(', ')}]  :: ${row.task}`,
  );
}
console.log(
  `\n  plan 模式均值 ${report.planMode.avgVisible.toFixed(1)}（min ${report.planMode.minVisible} / max ${report.planMode.maxVisible}）`,
);
console.log(
  '\n  口径提醒：本探针量**工具数**，不是 schema token 数；任务文本不命中任何类别时按 fail-safe 全放行。',
);

const JSON_OUT = arg('json', '');
if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`已写出 ${JSON_OUT}`);
}
