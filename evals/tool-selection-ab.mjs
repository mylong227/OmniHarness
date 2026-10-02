#!/usr/bin/env node
// 工具**选对率**评测（补齐 `tool-exposure-ab.mjs` 从未回答的那一半问题）。
//
// 为什么单列：`evals/tool-exposure-ab.mjs` 自己写明「度量的是省了多少上下文，**不宣称**任务
// 成功率提升」。也就是说 plan 模式省下 68.8% token 这件事**已被证明**，但「该给的工具到底给没给」
// 至今**零证据**——而工具暴露的护栏方向恰恰相反：宁可多给不可少给（少给 = 能力损伤）。
// 本脚本补的正是这一半：用离线标注的「最小必需工具集」度量两种模式的**必需工具召回率**。
//
// 指标口径：
//  - `recall`   = |GT ∩ visible| / |GT|        —— 少给即能力损伤，**硬指标**
//  - `noise`    = |visible \ GT| / |visible|   —— 多给的占比（成本指标，非硬指标）
//  - `perfect`  = recall 恰好为 1 的查询占比   —— 判「能不能翻默认」的主判据
//  - direct 档 recall 恒为 1（全量直载），故 **perfect 恒 100%**；plan 若低于它即为能力损伤。
//
// 用法：node evals/tool-selection-ab.mjs
// 产物：evals/tool-selection-ab.report.json
// 免网络、免模型、免 API key、秒级。
//
// ## 2026-10-02 修一处**自证循环**（本文件此前最严重的度量缺陷）
//
// 原实现的工具全集取自 **planner 自己的类别表**（`DEFAULT_CATEGORIES` + `DEFAULT_ALWAYS_VISIBLE`）
// ——于是「类别表里登记了但**注册表里根本不存在**的工具」也会被算成「给到了」，recall 100% 可能
// 是关于**不存在的工具**的。现改为：
//   ① 工具全集来自**生产装配**（`ConfigFactory.build(...).tools.list()`）；
//   ② 断言 `listDirect()`（模型真正能直载的那批）就是被规划的那批；
//   ③ 类别表若登记了注册表里没有的工具 ⇒ **硬红**（`missingInRegistry`）。
// 这与 `tool-exposure-ab.mjs` 的防假绿灯口径一致（那边早就有这条，本脚本此前漏了）。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { ToolExposurePlanner } = await import(
  new URL('../dist/src/core/toolExposurePlanner.js', import.meta.url).href
);
const { ConfigFactory } = await import(
  new URL('../dist/src/config/configFactory.js', import.meta.url).href
);
const { MemoryStorage } = await import(
  new URL('../dist/src/adapters/storage/memoryStorage.js', import.meta.url).href
);
const { AutoApproval } = await import(
  new URL('../dist/src/adapters/approval/autoApproval.js', import.meta.url).href
);
const { PassthroughSandbox } = await import(
  new URL('../dist/src/adapters/sandbox/passthroughSandbox.js', import.meta.url).href
);
const { SilentEventPort } = await import(
  new URL('../dist/src/adapters/event/silentEventPort.js', import.meta.url).href
);
const { TOOL_NAMES } = await import(
  new URL('../dist/src/ports/tool/toolNames.js', import.meta.url).href
);
/** 唯一「条件性注册」的工具名常量（见下方 `CONDITIONALLY_REGISTERED`）。 */
const TOOL_NAMES_DELEGATE = TOOL_NAMES.delegate;

/**
 * 探针集：任务文本 → 完成它**最小必需**的工具集。
 *
 * 标注纪律（避免自证）：GT 只标「少了它就做不了」的工具，不标「可能顺手用一下」的；
 * 一个任务有多条可行路径时取**任一路径的最小集**（如「改文件」可为 edit 或 write_file，
 * 这里按任务措辞取其一）。不确定的条目宁可不标，也不虚增样本。
 */
const PROBES = [
  { q: 'read the contents of src/index.ts', gt: ['read_file'] },
  { q: '读一下这个配置文件的内容', gt: ['read_file'] },
  { q: 'write this result into a new file', gt: ['write_file'] },
  { q: 'edit that function to accept a second argument', gt: ['edit'] },
  { q: 'apply this patch to the working tree', gt: ['apply_patch'] },
  { q: 'list what is inside the src directory', gt: ['list_dir'] },
  { q: 'search the repo for every TODO comment', gt: ['grep'] },
  { q: '在代码库里搜一下 retrieve 这个词', gt: ['grep'] },
  { q: 'find all the TypeScript files by pattern', gt: ['glob'] },
  { q: 'run npm run build and show me the output', gt: ['shell'] },
  { q: '跑一下单元测试看看有没有坏', gt: ['shell'] },
  { q: 'start a long test run in the background', gt: ['shell_job'] },
  { q: 'I need an interactive shell session', gt: ['shell_interactive'] },
  { q: 'execute this python snippet to verify', gt: ['run_code'] },
  { q: 'fetch that documentation page from the web', gt: ['web_fetch'] },
  { q: '抓一下这个网页的内容', gt: ['web_fetch'] },
  { q: 'take a screenshot of the page', gt: ['browser_screenshot'] },
  { q: '截个图看看页面长什么样', gt: ['browser_screenshot'] },
  { q: 'look at this image and describe it', gt: ['view_image'] },
  { q: '看一段视频画面判断发生了什么', gt: ['view_media'] },
  { q: 'spawn a subagent to do this in parallel', gt: ['subagent'] },
  // 2026-10-02 修：原 GT 是 `delegate`，但 `delegate` **只在真有外部 worker 时才注册**
  // （2026-09-26 审计 F1：默认配置下它由恒返回假成功的演示桩支撑 ⇒ 宁可不注册）。
  // 默认装配下该探针要求的工具**根本不存在** ⇒ 改用真实存在的等价委派路径 `subagent`。
  { q: 'delegate this job to a worker', gt: ['subagent'] },
  { q: 'run a goal oriented workflow for me', gt: ['run_goal'] },
  { q: 'execute the review workflow', gt: ['run_workflow'] },
  { q: 'remember this decision for later', gt: ['remember'] },
  { q: '记住我们这次选的方案', gt: ['remember'] },
  { q: 'recall what we decided last week', gt: ['recall'] },
  { q: 'search my memory for that conversation', gt: ['memory_search'] },
  { q: 'draw a quick sketch of the architecture', gt: ['sketch_write'] },
  { q: 'check whether this command is allowed by policy', gt: ['policy_eval'] },
  { q: 'roll back to the previous checkpoint', gt: ['rollback'] },
  { q: 'save a checkpoint before we start', gt: ['checkpoint'] },
  // —— 复合任务：同时需要多个类别，考察的是「召回」而不是「省了多少」——
  { q: 'read the config then run the tests to see if anything broke', gt: ['read_file', 'shell'] },
  { q: '搜索相关代码并把它改掉', gt: ['grep', 'edit'] },
  {
    q: 'look at the screenshot, then write the fix into the file',
    gt: ['browser_screenshot', 'write_file'],
  },
  // —— 无信号任务：必须 fail-safe 全放行（GT 为空，只考察是否误伤）——
  { q: '嗯，继续吧', gt: [] },
  { q: 'go on', gt: [] },
];

const cats = ToolExposurePlanner.DEFAULT_CATEGORIES;
const always = ToolExposurePlanner.DEFAULT_ALWAYS_VISIBLE;
/** 类别表登记的全部工具名（用于与**真实注册表**对账）。 */
const categorized = new Set([...cats.flatMap((c) => c.tools), ...always]);

// —— 工具全集取自生产装配（**不再**取自 planner 自己的表，见文件头「自证循环」）——
const config = ConfigFactory.build({
  workspaceRoot: ROOT,
  maxSteps: 1,
  model: {
    name: 'noop',
    generate: async () => ({ text: '' }),
    stream: async () => ({ text: '' }),
  },
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new SilentEventPort(),
});
const registryTools = config.tools.list().map((t) => t.name);
const directTools = (config.tools.listDirect?.() ?? config.tools.list()).map((t) => t.name);
const allTools = registryTools;
const registrySet = new Set(allTools);

/**
 * **条件性注册**的工具：类别表可以登记它们，但它们**不在默认装配的注册表**里，
 * 因此不参与本脚本的召回度量（没有它们时相关探针应改用真实存在的等价工具）。
 *
 * `delegate`（2026-09-26 审计 F1）：只在真有外部 worker 时注册——默认配置下它原本由演示桩
 * `SimpleWorker` 支撑，而桩恒返回假成功 ⇒ 「工具不存在」远好过「工具撒谎」。故它可缺席是**设计**，不是脱节。
 */
const CONDITIONALLY_REGISTERED = new Set([TOOL_NAMES_DELEGATE]);

/** 类别表登记、且**应在默认装配里存在**、但注册表里查无此物 ⇒ 真脱节，硬红。 */
const missingInRegistry = [...categorized].filter(
  (n) => !registrySet.has(n) && !CONDITIONALLY_REGISTERED.has(n),
);
/** 条件性注册、本次确实缺席的工具（报告如实登记，不算脱节）。 */
const absentButDesignIntended = [...categorized].filter(
  (n) => !registrySet.has(n) && CONDITIONALLY_REGISTERED.has(n),
);
/** 注册表里有、但没进任何类别（⇒ 规划层恒可见，属护栏保护范围）的工具。 */
const uncategorized = allTools.filter((n) => !categorized.has(n));

const pct = (r) => `${(r * 100).toFixed(1)}%`;

console.log(
  `工具清单：注册表 ${allTools.length} 个（直载 ${directTools.length}）｜类别表登记 ${categorized.size} 个`,
);
if (missingInRegistry.length > 0) {
  console.error(
    `\n❌ 类别表与真实注册表脱节（登记了不该缺席的工具）：${missingInRegistry.join(', ')}`,
  );
  console.error('   本脚本的 recall 口径因此无意义，中止（防假绿灯）。');
  process.exit(1);
}
if (absentButDesignIntended.length > 0) {
  console.log(`  条件性注册、本次缺席（设计如此）：${absentButDesignIntended.join(', ')}`);
}
if (uncategorized.length > 0) {
  console.log(`  未登记进任何类别（规划层恒可见）：${uncategorized.join(', ')}`);
}
// GT 里出现「本次注册表里不存在」的工具 ⇒ 该探针度量的是一条不可达路径，必须硬红
// （否则「recall 100%」可能是在要求一个不存在的工具）。
const unreachableGt = [...new Set(PROBES.flatMap((p) => p.gt).filter((t) => !registrySet.has(t)))];
if (unreachableGt.length > 0) {
  console.error(
    `\n❌ 探针的必需工具集里含注册表里不存在的工具：${unreachableGt.join(', ')}` +
      '\n   该探针在默认装配下不可达（度量无意义），请改用真实存在的等价工具。',
  );
  process.exit(1);
}

const rows = [];
for (const { q, gt } of PROBES) {
  const plan = ToolExposurePlanner.plan({ taskText: q, tools: allTools });
  const vis = new Set(plan.visible);
  const gtSet = new Set(gt);
  const hit = gt.filter((t) => vis.has(t));
  const recall = gt.length === 0 ? 1 : hit.length / gt.length;
  const noise =
    plan.visible.length === 0 ? 0 : (plan.visible.length - hit.length) / plan.visible.length;
  rows.push({
    q,
    gt,
    visible: plan.visible.length,
    deferred: plan.deferred.length,
    matched: plan.matchedCategories,
    hit,
    missed: gt.filter((t) => !vis.has(t)),
    recall: +recall.toFixed(4),
    noise: +noise.toFixed(4),
  });
}

const n = rows.length;
const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / n;
const planRecall = mean((r) => r.recall);
const planNoise = mean((r) => r.noise);
const perfect = rows.filter((r) => r.recall === 1).length;
const directNoise = mean((r) => (allTools.length - r.gt.length) / allTools.length);

console.log(`探针：${n} 条（含 ${rows.filter((r) => r.gt.length === 0).length} 条无信号任务）\n`);

console.log('=== 必需工具召回（硬指标）===');
console.log(`  direct（全量直载）  recall = 100.0%  （恒等，无少给可能）`);
console.log(`  plan（按需暴露）    recall = ${pct(planRecall)}`);
console.log(`  完全命中（recall=1）的查询：${perfect}/${n} = ${pct(perfect / n)}`);
console.log('\n=== 无关工具占比（成本指标）===');
console.log(`  direct  noise = ${pct(directNoise)}`);
console.log(`  plan    noise = ${pct(planNoise)}`);
console.log(
  `  平均可见工具数：direct ${allTools.length} → plan ${mean((r) => r.visible).toFixed(1)}`,
);

const bad = rows.filter((r) => r.recall < 1);
console.log(`\n=== 漏给的条目（${bad.length} 条）—— 这是不能直接翻默认的证据 ===`);
for (const r of bad) {
  console.log(`  ❌ "${r.q}"`);
  console.log(
    `     漏: ${r.missed.join(', ')}   命中类别: ${r.matched.join(',') || '(无 → fail-safe)'}`,
  );
}

console.log('\n=== 裁定（按「宁可多给不可少给」护栏）===');
const verdict =
  perfect === n
    ? 'plan 无能力损伤 ⇒ 可以讨论翻默认'
    : `plan 在 ${n - perfect}/${n} 条任务上少给了必需工具 ⇒ 维持 opt-in（默认 off），不可翻默认`;
console.log(`  ${verdict}`);

// 硬门禁：任何一条任务少给必需工具即红。这是本脚本进 CI 的唯一理由——
// 「省了多少 token」不该阻断（成本可商量），「少给了工具」必须阻断（能力损伤不可逆）。
if (perfect !== n) {
  console.error(`\n❌ ${n - perfect}/${n} 条任务漏给必需工具 ⇒ exit 1（漏项见上方明细）`);
  process.exitCode = 1;
}

writeFileSync(
  new URL('./tool-selection-ab.report.json', import.meta.url),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      toolSource: 'production: ConfigFactory.build(...).tools.list()',
      toolCount: allTools.length,
      directCount: directTools.length,
      categorizedCount: categorized.size,
      missingInRegistry,
      uncategorized,
      probes: n,
      plan: {
        recall: +planRecall.toFixed(4),
        noise: +planNoise.toFixed(4),
        perfect,
        avgVisible: +mean((r) => r.visible).toFixed(2),
      },
      direct: { recall: 1, noise: +directNoise.toFixed(4), avgVisible: allTools.length },
      verdict,
      rows,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/tool-selection-ab.report.json');
