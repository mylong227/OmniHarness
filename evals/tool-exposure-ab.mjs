#!/usr/bin/env node
// 工具按需暴露 A/B 度量（tool exposure A/B）——**走生产装配本体**，不用原型自证。
//
// 动机（借鉴来源见 docs/TASK_BOARD.md §17）：Laya 高基数实测——选项数固定、token 预算固定时，
// 每选项分到的 token 就是准确率天花板（77 选项 ⇒ 每标签 3–4 token ⇒ 0.870 塌到 0.425）。
// 工具集同形：`ConfigFactory.build` 默认装配 33 个工具**全部直载**，每步 33 份完整 schema 进上下文。
//
// 本脚本做四件事：
//   ① **清单核对**：打印生产默认装配的真实工具清单（33 个），并断言 planner 类别表里
//      写的每个工具名**都真实存在**——防「类别表写得漂亮但与现实脱节」这类假绿灯。
//   ② **覆盖率**：真实工具里有哪些**未被任何类别覆盖**（这些是恒可见的，属保守代价，如实列出）。
//   ③ **前后对照**：对一组中英代表任务，算 `off`（全量直载）vs `plan`（按需）的
//      **工具数**与 **schema token**，给出逐条与汇总降幅。
//   ④ **三护栏回归**：`visible ∪ deferred == 全部`、两者不相交、恒可见通道恒在。
//
// 用法（免网络、免模型）：npm run build && node evals/tool-exposure-ab.mjs
// 输出：evals/tool-exposure-ab.report.json + 控制台摘要。
//
// 口径诚实声明：token 用仓库既有 `tokenize`（词法分词器）度量，与 `production-defaults-check.mjs`
// 同口径，是**规模代理**而非 provider 真计费；本脚本度量的是**省了多少上下文**，
// **不宣称**任务成功率提升——能力侧的风险由三护栏（fail-safe / 未登记恒可见 / tool_search 可找回）兜。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { ConfigFactory } = await importDist('config', 'configFactory.js');
const { MemoryStorage } = await importDist('adapters', 'storage', 'memoryStorage.js');
const { AutoApproval } = await importDist('adapters', 'approval', 'autoApproval.js');
const { PassthroughSandbox } = await importDist('adapters', 'sandbox', 'passthroughSandbox.js');
const { ToolExposurePlanner } = await importDist('core', 'toolExposurePlanner.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');

/** 生产默认装配（与 `promptInjectionWiring.test.ts` 的 base() 同构，去掉无关替身）。 */
const config = ConfigFactory.build({
  workspaceRoot: ROOT,
  maxSteps: 4,
  model: { name: 'stub', generate: async () => ({ text: 'ok' }) },
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: { name: 'capture', emit() {} },
  extraTools: [],
});

const allTools = config.tools.list();
const direct = config.tools.listDirect?.() ?? allTools;
const names = direct.map((t) => t.name);

/** 工具 schema 的投递形态代理：名称 + 描述 + 参数 JSON Schema。 */
const wire = (t) => `${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.parameters)}`;
const tokensOf = (defs) => Bm25Index.tokenize(defs.map(wire).join('\n')).length;

const allTokens = tokensOf(direct);

console.log('=== ① 生产默认装配清单核对 ===');
console.log(
  `  工具总数 list()=${allTools.length}  直载 listDirect()=${direct.length}  （默认无一个 deferred）`,
);
const categorized = new Set(ToolExposurePlanner.DEFAULT_CATEGORIES.flatMap((c) => c.tools));
const missingInRegistry = [...categorized].filter((n) => !names.includes(n));
const uncovered = names.filter((n) => !categorized.has(n));
console.log(
  `  类别表登记工具 ${categorized.size} 个；其中**不在真实注册表中**的：${missingInRegistry.length} 个`,
);
if (missingInRegistry.length > 0) console.log(`    ❌ ${missingInRegistry.join(', ')}`);
console.log(`  真实工具中未被任何类别覆盖（⇒ 恒可见，保守代价）：${uncovered.length} 个`);
console.log(`    ${uncovered.join(', ') || '(无)'}`);
console.log(`  全量直载 schema token（口径：tokenize）：${allTokens}`);

if (missingInRegistry.length > 0) {
  console.error('\n❌ 类别表与真实注册表脱节，中止（防假绿灯）。');
  process.exit(1);
}

/** 代表任务（中英混排，覆盖各主要类别 + 1 条**无命中**用例以展示 fail-safe）。 */
const TASKS = [
  { id: 'fix-test', text: '修复 src/billing.test.ts 里失败的测试并跑一遍测试套件' },
  { id: 'grep-usage', text: 'grep 一下哪里用到了 RepoMapPayload' },
  { id: 'read-doc', text: '读取 docs/TASK_BOARD.md 并总结第 16 节' },
  { id: 'web-fetch', text: '抓取 https://example.com 的正文' },
  { id: 'screenshot', text: '把这个页面的截图看一下渲染效果' },
  { id: 'delegate', text: '派两个子代理并行调研这两个目录' },
  { id: 'memory', text: '回忆一下我上次说的偏好' },
  { id: 'sketch', text: '把仓库结构画成 mermaid 草图' },
  { id: 'plan-todo', text: '把计划写成待办清单' },
  { id: 'no-signal', text: '看看这个仓库整体怎么样' },
];

console.log('\n=== ③ 前后对照（off = 全量直载  vs  plan = 按需）===');
const rows = [];
let visSum = 0;
let tokSum = 0;
for (const { id, text } of TASKS) {
  const plan = ToolExposurePlanner.plan({ taskText: text, tools: names });
  const kept = direct.filter((t) => plan.visible.includes(t.name));
  const tok = tokensOf(kept);
  visSum += plan.visible.length;
  tokSum += tok;
  const drop = allTokens === 0 ? 0 : (1 - tok / allTokens) * 100;
  rows.push({
    id,
    task: text,
    matched: plan.matchedCategories,
    toolsOff: names.length,
    toolsPlan: plan.visible.length,
    tokensOff: allTokens,
    tokensPlan: tok,
    tokenDropPct: +drop.toFixed(1),
    reason: plan.reason,
  });
  console.log(
    `  ${id.padEnd(12)} 工具 ${String(names.length).padStart(2)}→${String(plan.visible.length).padStart(2)}` +
      `  token ${String(allTokens).padStart(5)}→${String(tok).padStart(5)}  (−${drop.toFixed(1)}%)` +
      `  命中[${plan.matchedCategories.join(',') || '无=全放行'}]`,
  );
}
const n = TASKS.length;
const avgTools = visSum / n;
const avgTok = tokSum / n;
const avgDrop = (1 - avgTok / allTokens) * 100;
console.log(
  `  ${'平均'.padEnd(12)} 工具 ${names.length}→${avgTools.toFixed(1)}` +
    `  token ${allTokens}→${Math.round(avgTok)}  (−${avgDrop.toFixed(1)}%)`,
);

console.log('\n=== ④ 三护栏回归（逐条、全部任务）===');
let unionOk = 0;
let disjointOk = 0;
let channelOk = 0;
for (const { text } of TASKS) {
  const plan = ToolExposurePlanner.plan({ taskText: text, tools: names });
  if (plan.visible.length + plan.deferred.length === names.length) unionOk++;
  if (plan.visible.every((x) => !plan.deferred.includes(x))) disjointOk++;
  const must = ToolExposurePlanner.DEFAULT_ALWAYS_VISIBLE.filter((x) => names.includes(x));
  if (must.every((x) => plan.visible.includes(x))) channelOk++;
}
console.log(`  完备性 visible∪deferred==全部 : ${unionOk}/${n}`);
console.log(`  两者不相交                    : ${disjointOk}/${n}`);
console.log(`  恒可见通道（存在者）恒在       : ${channelOk}/${n}`);

const report = {
  generatedAt: new Date().toISOString(),
  inventory: {
    total: allTools.length,
    direct: direct.length,
    allTokens,
    categorized: categorized.size,
    uncovered,
    missingInRegistry,
  },
  tasks: rows,
  summary: {
    tasks: n,
    toolsOff: names.length,
    toolsPlanAvg: +avgTools.toFixed(2),
    tokensOff: allTokens,
    tokensPlanAvg: Math.round(avgTok),
    tokenDropPctAvg: +avgDrop.toFixed(1),
  },
  invariants: { unionOk, disjointOk, channelOk, total: n },
};
/**
 * 写报告。**必须**与仓库的 `format:check` 门禁自洽：`JSON.stringify(x, null, 2)` 会把短数组
 * 展开成多行，而 Prettier 会把能塞进 printWidth 的数组折回一行 ⇒ 直接 stringify 会让
 * 「重跑一次本 eval」就把 `format:check` 弄红（且 `evals/*.report.json` 是入库文件）。
 * 故经 Prettier 的 Node API 落盘（devDependency，仅评测期用；缺失时回落 stringify 并如实提示）。
 */
let reportText = `${JSON.stringify(report, null, 2)}\n`;
try {
  const prettier = await import('prettier');
  reportText = await prettier.format(JSON.stringify(report), { parser: 'json' });
} catch {
  console.warn('  ⚠️ 未找到 Prettier，报告以 stringify 落盘；format:check 可能报此文件');
}
writeFileSync(new URL('./tool-exposure-ab.report.json', import.meta.url), reportText);
console.log('\nWrote evals/tool-exposure-ab.report.json');
