#!/usr/bin/env node
// 离线可观测性对账脚本（G24/O4，2026-10-03 第十轮）。
//
// ## 用途
//
// 读一个会话的落盘事件（JSONL，`<dir>/<sessionId>.jsonl` 样式的文件即可），跑 `TokenAttribution`，
// 断言两条恒等式，并单列"没有 usage 的模型调用"。它是**一次性对账工具**，不进 CI、
// 不联网、不需要 key：`node scripts/observabilityReconcile.mjs <事件文件> [更多文件…]`。
//
// ## 断言的两条恒等式（口径固定，改动即视为口径变更）
//
// 1. `Σ 桶.totalTokens == totalPromptTokens + totalCompletionTokens`（归因只做**分摊**，不造数）；
// 2. `Σ 桶(按桶维度分别求和) == 报告汇总的对应字段`（prompt/completion/cached 三个维度各自守恒）。
//
// **缓存读不计入 total**：`totalCachedPromptTokens` 是 prompt 的**子集**（缓存命中的输入仍是输入），
// 故它**不**参与第 1 条恒等式——把两者相加会把同一批 token 数两遍。
//
// ## 退出码
//
// 0 = 全部文件的恒等式成立；1 = 有文件不成立或读不出（把不成立当"对账失败"，供脚本串联使用）。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST_ENTRY = resolve('dist/src/observability/tokenAttribution.js');

/** 打印一行并返回该行的文本（便于统一前缀）。 */
function say(text) {
  process.stdout.write(`${text}\n`);
}

/** 从 JSONL 文本解析事件（坏行跳过并计数，不静默）。 */
function parseEvents(text) {
  const events = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  return { events, bad };
}

/**
 * 对账单个文件。
 * @returns 是否通过。
 */
function reconcile(file, TokenAttribution) {
  if (!existsSync(file)) {
    say(`✗ ${file}：文件不存在`);
    return false;
  }
  const { events, bad } = parseEvents(readFileSync(file, 'utf8'));
  const report = TokenAttribution.fromEvents(events);

  const sumBuckets = (pick) => report.buckets.reduce((acc, b) => acc + pick(b), 0);
  const identity1 =
    sumBuckets((b) => b.totalTokens) === report.totalPromptTokens + report.totalCompletionTokens;
  const identity2 =
    sumBuckets((b) => b.promptTokens) === report.totalPromptTokens &&
    sumBuckets((b) => b.completionTokens) === report.totalCompletionTokens &&
    sumBuckets((b) => b.cachedPromptTokens) === report.totalCachedPromptTokens;

  say(
    `${identity1 && identity2 ? '✓' : '✗'} ${file}：事件 ${String(events.length)} 条（坏行 ${String(bad)}）／` +
      `桶 ${String(report.buckets.length)} 个／total=${String(report.totalTokens)}` +
      `（prompt ${String(report.totalPromptTokens)} + completion ${String(report.totalCompletionTokens)}）／` +
      `cached=${String(report.totalCachedPromptTokens)}（prompt 的子集，不计入 total）`,
  );
  if (!identity1) {
    say(
      `    ✗ 恒等式① 失败：Σ桶 total=${String(sumBuckets((b) => b.totalTokens))} ≠ prompt+completion`,
    );
  }
  if (!identity2) {
    say('    ✗ 恒等式② 失败：分桶求和与汇总字段不一致（prompt/completion/cached 某一维不守恒）');
  }
  // 单列"没有 usage 的模型调用"：这类调用**不进任何桶**，是归因覆盖面的诚实缺口。
  say(
    `    模型调用：有 usage ${String(report.modelCallsWithUsage)} 次／无 usage ${String(report.modelCallsWithoutUsage)} 次`,
  );
  return identity1 && identity2;
}

/** 主流程：逐文件对账，任一失败即退出码 1。 */
async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    say('用法：node scripts/observabilityReconcile.mjs <事件文件.jsonl> [更多文件…]');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DIST_ENTRY)) {
    say(`✗ 找不到 ${DIST_ENTRY}：请先运行 npm run build（本脚本读编译产物，不引 TS 运行时）`);
    process.exitCode = 1;
    return;
  }
  const { TokenAttribution } = await import(pathToFileURL(DIST_ENTRY).href);
  let ok = true;
  for (const file of files) {
    // 先判存在再 stat：直接 statSync 会对缺失文件抛异常，把"读不出"变成崩溃而不是可诊断的失败。
    if (!existsSync(file) || !statSync(file).isFile()) {
      say(`✗ ${file}：不是可读文件`);
      ok = false;
      continue;
    }
    ok = reconcile(file, TokenAttribution) && ok;
  }
  process.exitCode = ok ? 0 : 1;
}

await main();
