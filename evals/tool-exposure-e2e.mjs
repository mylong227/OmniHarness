#!/usr/bin/env node
// 工具按需暴露（`OMNI_TOOL_EXPOSURE=plan`）的**端到端验证**——驱动真 Agent 回合，检查
// 「模型实际收到的 `request.tools`」，而不是在探针里复算一遍 `ToolExposurePlanner.plan()`。
//
// ## 为什么需要它（此前两份报告都不够）
//
// `evals/tool-exposure-ab.mjs` 与 `evals/tool-selection-ab.mjs` **都只调用纯函数 `plan()`**：
//   · 前者自己 re-implement 了 `exposeByRelevance` 的过滤（正是 `docs/TASK_BOARD.md` §「验收探针
//     禁止自带被测逻辑的副本」明令禁止的形态——装配一变，探针立刻失真）；
//   · 后者更远：它的工具全集**取自 planner 自己的类别表**，与真实注册表无关（自证循环）。
// 于是「接线是否真的生效」「模型这一回合到底拿到哪些工具」这两个问题，**从来没有被测过**。
// 本脚本用生产装配路径回答它：
//
//   `ConfigFactory.build` → `Runtime.createRuntime` → `new Agent(runtime)` → `agent.runTask`
//
// 模型是本地录制桩（零 API key、零网络推理），每次 `generate(request)` 把 `request.tools`
// 原样留下——`request.tools` 就是**真实发给模型的那份工具表**，无任何复算余地。
//
// ## 硬断言（任一不成立即 exit 1）
//
//   ① 接线生效：`off` 与 `plan` 两臂的首个主请求工具表必须**不同**（相同 = 开关没生效）；
//   ② 直载集被真的裁小：`plan` 臂首个主请求可见工具数 < `off` 臂（否则「按需暴露」名存实亡）；
//   ③ 计划一致性：`plan` 臂首个主请求的工具名集合 ⊆ `ToolExposurePlanner.plan()` 的
//      `visible ∪ 恒可见`（**这里调 planner 是拿「期望值」，不是复算被测代码**——被测量是
//      `request.tools` 本身，二者来自完全不同的路径，故不构成自证循环）；
//   ④ 稳定子集：后续步的工具集必须**包含**首步工具集（会话中途不得反悔已给的直载工具）；
//   ⑤ 可找回（#M1 闭环，端到端版）：经 `tool_search` 找回的工具，必须真的出现在**下一步**
//      的 `request.tools` 里——这条同时证明「延迟加载不是能力删除」。
//   ⑥ **零能力损伤**（2026-10-02 加）：多个场景（每类一个真实任务文本）各跑一次真 Agent 回合，
//      断言**每一步**的 `request.tools` 都覆盖该场景的「必需工具」——即在**真实回合里**逐场景
//      验证「少给 = 能力损伤」这条护栏不会破。
//
// ## `--gate`（翻默认判据的可执行形态）
//
// 本仓 D6 的「两关」是为**排序/检索路**写的（否决器 + 采样 A/B + bootstrap CI），对「工具暴露」
// 这种**确定性的集合成员属性**没有操作形态（无采样、无 CI、无留出折）。故在此把它落成可执行判据：
// 本脚本 `--gate` = **零能力损伤的端到端证据**，配套 `tool-selection-ab.mjs`（工具全集取自生产
// 注册表、37 条必需工具召回，已进 `eval:ci`）——两者同时绿才允许把默认从 `off` 翻为 `plan`。
//
// 用法：node evals/tool-exposure-e2e.mjs [--gate]
// 产物：evals/tool-exposure-e2e.report.json
// 免网络、免模型、免 API key。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
/** `--gate`：翻默认判据的可执行形态（不过即 exit 1）。 */
const GATE = process.argv.includes('--gate');

const { Agent } = await import(new URL('../dist/src/core/agent.js', import.meta.url).href);
const { Runtime } = await import(
  new URL('../dist/src/composition/runtime.js', import.meta.url).href
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
const { ToolExposurePlanner } = await import(
  new URL('../dist/src/core/toolExposurePlanner.js', import.meta.url).href
);

/** 任务文本：刻意只命中 `files` 类别（不得含 web / visual / delegate 等词）。 */
const PROMPT = '帮我读一下 src/core/agent.ts 这个文件';

/**
 * 录制型模型端口：把**每次真实发出的 `request.tools`** 原样留下，再按脚本回应。
 * 不联网、不推理 ⇒ 结论只反映「工具表组装」这一层，与模型能力无关。
 */
class RecordingModel {
  /**
   * @param script 主回路脚本化回应序列（不足时重复最后一项）。
   */
  constructor(script) {
    /** 端口名。 */
    this.name = 'recording-e2e';
    this.script = script;
    this.mainCalls = 0;
    this.sideCalls = 0;
    /** 每次调用的工具名快照（含旁路调用，用 `mainRequests()` 过滤）。 */
    this.frames = [];
  }

  /**
   * 录制并回应。
   * @param request 模型请求（含 messages / tools）。
   * @returns 主回路按脚本回应；旁路调用回空 JSON 数组。
   */
  async generate(request) {
    const isMain = request.messages.length > 0 && request.messages[0].role === 'system';
    this.frames.push({
      main: isMain,
      tools: (request.tools ?? []).map((t) => t.name),
    });
    if (!isMain) {
      this.sideCalls += 1;
      return { text: '[]' };
    }
    const step = this.script[Math.min(this.mainCalls, this.script.length - 1)];
    this.mainCalls += 1;
    return step;
  }

  /** 只取主回路请求的工具名快照。
   * @returns 每步的工具名数组。
   */
  mainRequests() {
    return this.frames.filter((f) => f.main).map((f) => f.tools);
  }
}

/** 构造最小可用配置（走 ConfigFactory.build）。
 * @param model 录制型模型端口。
 * @returns 可交给 ConfigFactory.build 的输入。
 */
const base = (model) => ({
  workspaceRoot: ROOT,
  maxSteps: 8,
  model,
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new SilentEventPort(),
  memoryConsolidate: false,
  // 关压缩：压缩会改写上下文，是另一个独立变量，必须隔离。
  compactionMaxTokens: 100_000_000,
});

/** 脚本：读文件 → 找回 web_fetch → 调 web_fetch → 收尾。 */
const SCRIPT = [
  { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'src/core/agent.ts' } }] },
  { toolCalls: [{ id: 's1', name: 'tool_search', arguments: { query: 'web fetch url' } }] },
  {
    toolCalls: [{ id: 'w1', name: 'web_fetch', arguments: { url: 'https://example.com/' } }],
  },
  { text: '端到端验证完成' },
];

/**
 * 跑一臂。
 *
 * `off` 臂**显式**置 `OMNI_TOOL_EXPOSURE=off`（翻默认后它已是逃生口，不再是「未设」）；
 * `plan` 臂**删掉**该变量——测的正是「未设时默认即 plan」这条翻默认结论本身。
 * @param mode `off` 或 `plan`（后者 = 未设，走默认）。
 * @returns 每步的工具名数组。
 */
const runArm = async (mode) => {
  const prev = process.env['OMNI_TOOL_EXPOSURE'];
  if (mode === 'off') process.env['OMNI_TOOL_EXPOSURE'] = 'off';
  else delete process.env['OMNI_TOOL_EXPOSURE'];
  try {
    const model = new RecordingModel(SCRIPT);
    const runtime = Runtime.createRuntime(ConfigFactory.build(base(model)));
    const agent = new Agent(runtime);
    await agent.runTask(PROMPT);
    return model.mainRequests();
  } finally {
    if (prev === undefined) delete process.env['OMNI_TOOL_EXPOSURE'];
    else process.env['OMNI_TOOL_EXPOSURE'] = prev;
  }
};

const offArm = await runArm('off');
const planArm = await runArm('plan');

const offFirst = offArm[0] ?? [];
const planFirst = planArm[0] ?? [];
const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(`${label}${detail === undefined ? '' : `（${detail}）`}`);
};

console.log(`\n=== [1] 两臂首个主请求的工具表 ===`);
console.log(`  off : ${offFirst.length} 个：${offFirst.join(', ')}`);
console.log(`  plan: ${planFirst.length} 个：${planFirst.join(', ')}`);

console.log(`\n=== [2] 硬断言（任一不成立即红）===`);
check(
  JSON.stringify(offFirst) !== JSON.stringify(planFirst),
  '① 接线生效：两臂首个主请求工具表不同',
);
check(
  planFirst.length < offFirst.length,
  '② 直载集被真的裁小',
  `${String(offFirst.length)} → ${String(planFirst.length)}`,
);

// 期望值来自 planner 的「计划」（可见 ∪ 恒可见 ∪ 未登记）——被测量是 request.tools，两条路径独立。
const expected = (() => {
  const plan = ToolExposurePlanner.plan({
    taskText: PROMPT,
    tools: offFirst,
  });
  return new Set([...plan.visible, ...ToolExposurePlanner.DEFAULT_ALWAYS_VISIBLE]);
})();
const unexpected = planFirst.filter((n) => !expected.has(n));
check(
  unexpected.length === 0,
  '③ 计划一致性：plan 臂首个主请求 ⊆ 计划可见集',
  unexpected.length === 0 ? undefined : `越界工具 ${unexpected.join(', ')}`,
);

const planSteps = planArm.length;
let stable = true;
for (let i = 1; i < planSteps; i += 1) {
  const prev = new Set(planArm[i - 1]);
  const cur = new Set(planArm[i]);
  for (const n of prev) {
    if (!cur.has(n)) stable = false;
  }
}
check(stable, '④ 稳定子集：后续步不反悔首步已给的直载工具', `${String(planSteps)} 步`);

// ⑤ 可找回：web_fetch 在首步被延迟；经 tool_search 后必须出现在其后某步的工具表里。
const deferredFirst = !planFirst.includes('web_fetch');
const recoveredAt = planArm.findIndex((step, i) => i > 0 && step.includes('web_fetch'));
console.log(
  `\n  延迟证据：web_fetch ${deferredFirst ? '首步被延迟 ✅' : '首步就在（该文本命中 web 类别？）'}；` +
    `找回后出现于第 ${recoveredAt >= 0 ? String(recoveredAt) : '—'} 步`,
);
check(
  deferredFirst && recoveredAt > 0,
  '⑤ 可找回（端到端）：延迟的 web_fetch 经 tool_search 后进入下一步工具表',
);

// ── ⑥ 零能力损伤：逐场景在**真实回合**里核对必需工具是否都在 `request.tools` 里 ──────────
// GT 口径与 `tool-selection-ab.mjs` 一致（「少了它就做不了」的最小集，不标「顺手用一下」的）。
// 每个场景跑一次真 Agent 回合，断言**每一步**都覆盖 GT——这比只看首个请求更强：
// 「延迟加载让某步悄悄少了工具」也会被抓到。
const SCENARIOS = [
  {
    name: 'read+shell',
    q: 'read the config then run the tests to see if anything broke',
    gt: ['read_file', 'shell'],
  },
  { name: 'search+edit', q: '搜索相关代码并把它改掉', gt: ['grep', 'edit'] },
  {
    name: 'visual+write',
    q: 'look at the screenshot, then write the fix into the file',
    gt: ['browser_screenshot', 'write_file'],
  },
  { name: 'memory', q: '记住我们这次选的方案', gt: ['remember'] },
  { name: 'planning-only', q: '帮我拆一下这个任务的步骤', gt: ['todo_write'] },
  { name: 'no-signal fail-safe', q: '嗯，继续吧', gt: [] },
];

/**
 * 跑一个场景（真 Agent 回合）并返回每步的工具表。
 * @param text 任务文本。
 * @returns 每步的工具名数组。
 */
const runScenario = async (text) => {
  const prev = process.env['OMNI_TOOL_EXPOSURE'];
  process.env['OMNI_TOOL_EXPOSURE'] = 'plan';
  try {
    const model = new RecordingModel([{ text: '场景完成' }]);
    const runtime = Runtime.createRuntime(ConfigFactory.build(base(model)));
    const agent = new Agent(runtime);
    await agent.runTask(text);
    return model.mainRequests();
  } finally {
    if (prev === undefined) delete process.env['OMNI_TOOL_EXPOSURE'];
    else process.env['OMNI_TOOL_EXPOSURE'] = prev;
  }
};

console.log('\n=== [3] 零能力损伤（翻默认判据⑥，逐场景真 Agent 回合）===');
const scenarioRows = [];
for (const scene of SCENARIOS) {
  const steps = await runScenario(scene.q);
  const missingPerStep = steps.map((tools) => {
    const set = new Set(tools);
    return scene.gt.filter((t) => !set.has(t));
  });
  const missing = [...new Set(missingPerStep.flat())];
  const ok = missing.length === 0;
  scenarioRows.push({
    name: scene.name,
    q: scene.q,
    gt: scene.gt,
    steps: steps.length,
    stepToolCounts: steps.map((s) => s.length),
    missing,
    ok,
  });
  console.log(
    `  ${ok ? '✅' : '❌'} ${scene.name}：必需 [${scene.gt.join(', ') || '（无，fail-safe）'}]` +
      `｜步数 ${String(steps.length)}｜首步工具数 ${String(steps[0]?.length ?? 0)}` +
      (ok ? '' : `｜**漏给**: ${missing.join(', ')}`),
  );
}
const lostScenarios = scenarioRows.filter((r) => !r.ok);
check(
  lostScenarios.length === 0,
  '⑥ 零能力损伤：全部场景的每一步都覆盖其必需工具',
  lostScenarios.length === 0
    ? `${String(SCENARIOS.length)} 个场景`
    : `${String(lostScenarios.length)} 个场景漏给必需工具`,
);

const report = {
  eval: 'tool-exposure-e2e',
  path: 'production: ConfigFactory.build → Runtime.createRuntime → Agent.runTask → request.tools',
  prompt: PROMPT,
  mode: {
    switch: 'OMNI_TOOL_EXPOSURE',
    defaultWhenUnset: 'plan（2026-10-02 翻默认）',
    offArm: 'OMNI_TOOL_EXPOSURE=off（显式逃生口）',
    planArm: '未设该变量（即默认）',
  },
  off: { firstRequestTools: offFirst, steps: offArm.map((s) => s.length) },
  plan: { firstRequestTools: planFirst, steps: planArm.map((s) => s.length) },
  visibleReduction: {
    from: offFirst.length,
    to: planFirst.length,
    pct: +(((offFirst.length - planFirst.length) / Math.max(1, offFirst.length)) * 100).toFixed(1),
  },
  deferredFirstStep: offFirst.filter((n) => !planFirst.includes(n)),
  recoveredAfterToolSearch: recoveredAt > 0 ? planArm[recoveredAt] : null,
  assertions: {
    wiringAlive: JSON.stringify(offFirst) !== JSON.stringify(planFirst),
    reduced: planFirst.length < offFirst.length,
    plannedSubset: unexpected.length === 0,
    stableSubset: stable,
    recoveryWorks: deferredFirst && recoveredAt > 0,
    zeroCapabilityLoss: lostScenarios.length === 0,
  },
  scenarios: scenarioRows,
  flipCriterion:
    '①–⑤ 端到端断言 + ⑥ 逐场景零能力损伤（本脚本 --gate），' +
    '配套 tool-selection-ab.mjs 的注册表来源 37 条必需工具召回 100%（进 eval:ci）。' +
    'D6「两关」是为排序/检索路写的，对确定性的集合成员属性无操作形态，故以此为准。',
  passed: failures.length === 0,
  failures,
  at: new Date().toISOString(),
};
writeFileSync(
  new URL('./tool-exposure-e2e.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/tool-exposure-e2e.report.json');

if (failures.length > 0) {
  console.log('\n=== 判定：FAIL ===');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else if (GATE) {
  console.log('\n=== --gate 判定：PASS（翻默认判据全过）===');
} else {
  console.log('\n=== 判定：PASS（端到端断言全过；加 --gate 走翻默认判据）===');
}
