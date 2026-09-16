#!/usr/bin/env node
// E2E 通道 + 判定器**两关**验证（D6：放行 ≠ 有效）。
// 用 Gitee 镜像跑通 NativeExecutor 全链路（克隆 → worktree → uv venv → 装依赖 → 应用补丁 → pytest 判定）。
//
// 第一关（通道是否通）：空模型补丁 ⇒ 期望 `resolved:false` **且 reason 为空**。
//   reason 为空意味着走完了全流程、拿到 pytest 的真实失败结果；而非「克隆失败 / uv 不可用 /
//   工作区检出失败」这类设施性 fail-closed。即：用 reason 的**类型**区分「通道不通」与「通道通了但补丁不对」。
// 第二关（判定器是否有效）：官方 gold patch ⇒ 期望 `resolved:true`。
//   若金标补丁都判不过，说明**判定器恒假或环境不保真**——通道「通」也无意义。这是本文件的核心价值：
//   真实现场（2026-09-17）正是靠第二关才发现环境保真度缺口（pytest 9.x 顶掉仓库 pin 的 7.2.2 +
//   Werkzeug 3.x 顶掉仓库期望的 2.x），第一关永远发现不了。
//
// 用法：node evals/e2e-native-gitee-smoke.mjs [repo]
// 默认 pallets/flask（最小的一个目标仓库）。

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { NativeExecutor } = await import(
  pathToFileURL(join(ROOT, 'dist', 'src', 'eval', 'nativeExecutor.js')).href
);
const { SwebenchVerified } = await import(
  pathToFileURL(join(ROOT, 'dist', 'src', 'eval', 'swebenchVerified.js')).href
);

const repo = process.argv[2] ?? 'pallets/flask';
// 关键：必须走 `loadVerified` 归一化（含 FAIL_TO_PASS/PASS_TO_PASS 的 JSON 字符串解析 + 空清单 fail-closed）。
// 踩坑留档：初版直接 `JSON.parse(...).find(t => t.repo === repo)` 把**原始 JSON** 喂给执行器，
// 而数据集字段是 snake_case 的 `base_commit`，执行器要的是 `baseCommit` ⇒ 检出到 `undefined`
// 引用，git 报 `fatal: invalid reference: undefined`。本文件是 .mjs，**没有类型检查兜这个错**，
// 于是伪装成「通道不通」。凡是把外部数据喂进强类型执行器的地方，都必须先过归一化层。
const dataset = SwebenchVerified.loadVerified(join(ROOT, 'eval-data', 'swe_bench_verified.json'));
const mirrors = JSON.parse(
  readFileSync(join(ROOT, 'benchmark', 'swebench-gitee-mirrors.json'), 'utf8'),
);
const pins = JSON.parse(readFileSync(join(ROOT, 'benchmark', 'swebench-env-pins.json'), 'utf8'));
const task = dataset.find((t) => t.repo === repo);
if (task === undefined) {
  console.error(`数据集里没有 ${repo}`);
  process.exit(1);
}

const executor = new NativeExecutor({
  repoBaseUrl: 'https://gitee.com/',
  repoMirrors: mirrors.mirrors,
  envPins: pins.pins,
  repoCacheRoot: 'D:/deepseek/.omni-swebench-repos',
});
console.log(`executor = ${executor.describe()}`);
console.log(`task     = ${task.id}  base=${task.baseCommit}  version=${task.version}`);
console.log(
  `测试清单 = FAIL_TO_PASS ${task.failToPass.length} 项 / PASS_TO_PASS ${task.passToPass.length} 项\n`,
);

/** 设施性 fail-closed 的原因特征（用于区分「通道不通」与「判定结果」）。 */
const FACILITY = /克隆失败|工作区检出失败|uv 不可用|git 不可用|原生执行异常/;

/**
 * 跑一次并计时。
 * @param patch 模型补丁（空串=第一关；gold=第二关）。
 * @returns `{ result, seconds }`。
 */
async function attempt(patch) {
  const t0 = Date.now();
  try {
    const result = await executor.run(task, patch);
    return { result, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
  } catch (error) {
    console.error(`❌ run() 抛出异常（wrap 层未兜住）：${error?.message ?? error}`);
    process.exit(2);
  }
}

// ---- 第一关：通道是否通（空补丁 ⇒ 未修复，但 reason 必须为空）----
const g1 = await attempt('');
console.log(`[第一关·通道] 空补丁 耗时 ${g1.seconds}s → ${JSON.stringify(g1.result)}`);
const r1 = g1.result.reason ?? '';
const gate1 = g1.result.resolved === false && r1 === '';
if (!gate1) {
  console.log(
    FACILITY.test(r1) ? `❌ 通道未通（设施性 fail-closed）：${r1}` : `⚠️ 第一关异常：reason=${r1}`,
  );
  process.exit(3);
}
console.log('✅ 第一关通过：走完全流程，pytest 给出真实失败结果（空补丁理当未修复）。\n');

// ---- 第二关：判定器是否有效（gold 补丁 ⇒ 必须 resolved）----
const g2 = await attempt(task.goldPatch);
console.log(`[第二关·判定] gold 补丁 耗时 ${g2.seconds}s → ${JSON.stringify(g2.result)}`);
const gate2 = g2.result.resolved === true;
if (gate2) {
  console.log(
    '✅ 第二关通过：官方 gold patch 被判 resolved —— 判定器双向有效（不是恒假），环境保真度足以复现。',
  );
} else {
  console.log(
    `❌ 第二关未过：gold patch 竟未 resolved（reason=${g2.result.reason ?? '空'}）。` +
      '判定器或环境保真度有问题 —— 通道「通」不可信，须先修环境再谈出分。',
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  repo,
  instanceId: task.id,
  baseCommit: task.baseCommit,
  version: task.version,
  repoBaseUrl: 'https://gitee.com/',
  failToPassCount: task.failToPass.length,
  passToPassCount: task.passToPass.length,
  gate1_channelOpen: gate1,
  gate2_goldResolved: gate2,
  emptyPatch: { seconds: g1.seconds, result: g1.result },
  goldPatch: { seconds: g2.seconds, result: g2.result },
};
writeFileSync(
  join(ROOT, 'evals', 'e2e-native-gitee-smoke.report.json'),
  JSON.stringify(report, null, 2),
);
process.exit(gate2 ? 0 : 4);
