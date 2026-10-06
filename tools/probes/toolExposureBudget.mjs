#!/usr/bin/env node
/**
 * 工具暴露规划探针（G21 提升入库 / G21-b 接真实 schema，2026-10-03；**离线、免网络、免模型、确定性**）。
 *
 * ## 回答什么问题
 *
 * 报告 §3.4 的实证是「工具 schema 预算是真实成本（Anthropic 一手：Claude Code 默认把工具响应限在
 * 25,000 token；playwright-mcp 自述编码 agent 正转向 CLI+SKILL 以避免大 schema 入库）」。本仓的
 * 处方是 `ToolExposurePlanner`：按任务文本命中的类别把工具**降为延迟加载**（可经 `tool_search` 找回）。
 * 本探针量两件事：**可见工具数**与**真实 schema 的估算 token 代价**（及其节省）。
 *
 * ## 口径
 *
 * - **工具数**：`src/ports/tool/toolNames.ts`（工具名单一来源）的名字表；
 * - **schema token**：由 `ConfigFactory.build({ workspaceRoot })`（**离线可跑的生产装配入口**——不建模型连接、
 *   不读密钥）取**默认配置下真实注册**的工具定义（name + description + parameters），再用
 *   `TokenEstimator.estimate` 估算；token 汇总按"规划器选中的名字 ∩ 已注册定义"计算；
 * - **两者数目可以不同**（实测：名字表 46 项、默认配置注册 33 个）——条件注册的工具（LSP/MCP/媒体等）
 *   在默认配置下不出现。这不是矛盾，是"名字表 ⊃ 默认注册集"；
 * - `off` 模式 = 不干预（全部可见/全部下发），`plan` 模式 = 按类别规划（本仓 `OMNI_TOOL_EXPOSURE=plan` 启用）。
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
 *
 * ## 诚实边界
 *
 * - schema token 由 `TokenEstimator` **估算**（启发式，非真 tokenizer）⇒ 适合同机同版本对比，不当作绝对账；
 * - 只含**工具 schema**（name/description/parameters），**不含工具结果**（运行时的大头另由上下文预算管）；
 * - 任务文本**不命中任何类别**时按 fail-safe **全放行**（节省 0%）——刻意的保守设计，不是缺陷。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeArgs } from './_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

// 参数解析排在 dist 动态 import **之前**（理由见 `_args.mjs` 头注释）。
const a = probeArgs({ values: { task: '', json: '' } });

let ToolExposurePlanner;
let TOOL_NAMES;
let ConfigFactory;
let TokenEstimator;
try {
  ({ ToolExposurePlanner } = await importDist('core', 'toolExposurePlanner.js'));
  ({ TOOL_NAMES } = await importDist('ports', 'tool', 'toolNames.js'));
  // G21-b：接**真实 schema** 需要生产配置栈（离线可跑：`ConfigFactory.build({})` 不需要模型/网络）。
  ({ ConfigFactory } = await importDist('config', 'configFactory.js'));
  ({ TokenEstimator } = await importDist('context', 'tokenEstimator.js'));
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
 * 取**默认配置**下真实注册的工具定义（名 + 描述 + JSON schema）。
 *
 * 为什么这样取：schema token 预算必须有**真实 schema**才可信（规划器只看名字，看不到 schema）。
 * `ConfigFactory.build({ workspaceRoot })` 是生产装配入口且**离线可跑**（不建模型连接、不读密钥）——
 * 拿到的就是"默认配置下会下发给模型的工具集"，而非人工构造的假 schema。
 * @returns {{definitions: readonly object[], note: string}} 定义表与口径说明。
 */
function realDefinitions() {
  const config = ConfigFactory.build({ workspaceRoot: ROOT });
  const list = config.tools.list();
  return {
    definitions: list,
    note: '默认配置（ConfigFactory.build({workspaceRoot})）真实注册的工具定义',
  };
}

/**
 * 单个工具 schema 的 token 代价（名字 + 描述 + JSON schema 一起算——三者都要进请求）。
 * @param {object} definition 工具定义。
 * @param {object} estimator TokenEstimator 实例。
 * @returns {number} 估算 token。
 */
function schemaTokensOf(definition, estimator) {
  const parts = [
    String(definition.name ?? ''),
    String(definition.description ?? ''),
    JSON.stringify(definition.parameters ?? {}),
  ];
  return estimator.estimate(parts.join('\n'));
}

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

const only = String(a.task);
const rows = (only === '' ? TASKS : [only]).map((task) => planOf(task));

// ---- G21-b：接**真实 schema** 的 token 预算（离线；schema 取自默认配置的生产注册表）----
const { definitions, note: schemaNote } = realDefinitions();
const estimator = new TokenEstimator();
const schemaTokens = new Map(
  definitions.map((definition) => [String(definition.name), schemaTokensOf(definition, estimator)]),
);
const offSchemaTokens = [...schemaTokens.values()].reduce((a, b) => a + b, 0);
const schemaRows = rows.map((row) => {
  const plan = ToolExposurePlanner.plan({
    taskText: row.task,
    tools: definitions.map((d) => String(d.name)),
  });
  const visibleTokens = plan.visible.reduce((sum, name) => sum + (schemaTokens.get(name) ?? 0), 0);
  return {
    task: row.task,
    visible: plan.visible.length,
    total: definitions.length,
    visibleSchemaTokens: visibleTokens,
    offSchemaTokens,
    savedTokens: offSchemaTokens - visibleTokens,
    savedRatio: offSchemaTokens === 0 ? 0 : (offSchemaTokens - visibleTokens) / offSchemaTokens,
  };
});

const report = {
  probe: 'toolExposureBudget',
  measures: '可见工具数 + 真实 schema 的估算 token（G21-b 已接真实 schema）',
  totalTools: ALL_TOOLS.length,
  offMode: { visible: ALL_TOOLS.length, note: 'off 模式不干预 ⇒ 全部可见' },
  planMode: {
    rows,
    avgVisible: rows.reduce((s, r) => s + r.visible, 0) / rows.length,
    maxVisible: Math.max(...rows.map((r) => r.visible)),
    minVisible: Math.min(...rows.map((r) => r.visible)),
  },
  schemaBudget: {
    caliber: schemaNote,
    registeredTools: definitions.length,
    offSchemaTokens,
    rows: schemaRows,
    minSavedTokens: Math.min(...schemaRows.map((r) => r.savedTokens)),
    maxSavedTokens: Math.max(...schemaRows.map((r) => r.savedTokens)),
    minSavedRatio: Math.min(...schemaRows.map((r) => r.savedRatio)),
    maxSavedRatio: Math.max(...schemaRows.map((r) => r.savedRatio)),
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
  `\n=== schema token 预算（G21-b：真实 schema，共 ${String(definitions.length)} 个注册工具）===`,
);
console.log(`  off 模式（全部下发）：${String(offSchemaTokens)} token`);
for (const row of schemaRows) {
  console.log(
    `  ${String(row.visible).padStart(3)}/${String(row.total)} 个工具 = ${String(row.visibleSchemaTokens).padStart(5)} token` +
      `  （省 ${String(row.savedTokens)} token / ${(row.savedRatio * 100).toFixed(1)}%）  :: ${row.task}`,
  );
}
console.log(
  `\n  节省区间：${String(report.schemaBudget.minSavedTokens)}～${String(report.schemaBudget.maxSavedTokens)} token` +
    `（${(report.schemaBudget.minSavedRatio * 100).toFixed(1)}%～${(report.schemaBudget.maxSavedRatio * 100).toFixed(1)}%）`,
);
console.log(
  '\n  口径提醒：① 工具数是**可见计数**；② schema token 由 `TokenEstimator` 估算（启发式，非真 tokenizer），' +
    '只含工具的 name/description/parameters，不含工具结果；③ 任务文本不命中任何类别时按 fail-safe 全放行。',
);

const JSON_OUT = String(a.json);
if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`已写出 ${JSON_OUT}`);
}
