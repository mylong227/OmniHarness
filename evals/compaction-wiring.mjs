#!/usr/bin/env node
// 投影层「确定性无损收缩」接线前后对照实测（零依赖 · 无网络 · 可复现）。
//
// 动机：仓库早就有 DeterministicCompressor（**能力**），但生产链路零调用——典型缺陷形态
// 「声明未接线」。本轮把它接进 ContextCompactor（`events → 投影 → 压缩 → 发往模型` 的
// 唯一塑形缝；记录层保持忠实，绝不改审计内容）。本脚本只量化**接线本身**的收益：
//
//   A 接线前 = `deterministicShrink:false`（逐字节旧行为）
//   B 接线后 = `deterministicShrink:true`（默认）
//
// 三个口径：
//   ① 未达压缩阈值（长会话的常态）→ 每轮都在省 ⇒ **持续收益**；
//   ② 触达压缩阈值 → 保留的 tail 仍在省 ⇒ **压缩时收益**；
//   ③ 只看「整段 JSON」型工具输出（真实工具输出的主导形态）⇒ **机制射程**。
//
// 语料纪律：全部取**仓库真实产物**（真实 JSON 报告 / 真实源码 / 真实 Markdown），
// 不合成对自己有利的数据；文件缺失按纪律跳过并记账。消息序列按真实 wire 形状构造
// （assistant(tool_calls) → tool(result) 成对），避免触发 orphan-tool 守卫。
//
// 用法：npm run build && node evals/compaction-wiring.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ContextCompactor } from '../dist/src/context/contextCompactor.js';
import {
  DeterministicCompressor,
  byteLength,
} from '../dist/src/context/deterministicCompressor.js';
import { TokenEstimator } from '../dist/src/context/tokenEstimator.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const round = (x, d = 2) => Number(x.toFixed(d));

/**
 * 真实语料：仓库自有产物，非 JSON 在前、JSON 在后
 * （贴近真实会话：先读源码/文档，最后读一批 JSON 报告）。
 */
const REAL_CORPUS = [
  { path: 'docs/TASK_BOARD.md', tool: 'read_file' },
  { path: 'src/context/contextCompactor.ts', tool: 'read_file' },
  { path: 'src/context/deterministicCompressor.ts', tool: 'read_file' },
  { path: 'tsconfig.json', tool: 'read_file' },
  { path: 'package.json', tool: 'read_file' },
  { path: 'evals/context-efficiency/RESULTS.json', tool: 'run_command' },
  { path: 'evals/injection-metric.report.json', tool: 'run_command' },
  { path: 'benchmark/capability-swebench.json', tool: 'run_command' },
];

const skipped = [];
/** 构造真实消息序列：每条 tool 结果前置一条 assistant(tool_calls)（真实 wire 形状）。 */
function buildMessages() {
  const messages = [{ role: 'system', content: 'You are OmniHarness.\n\n\n\n零依赖铁律。  \n' }];
  let index = 0;
  for (const item of REAL_CORPUS) {
    let text;
    try {
      text = readFileSync(join(ROOT, item.path), 'utf8');
    } catch {
      skipped.push(item.path);
      continue;
    }
    const callId = `c${index}`;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: callId, name: item.tool, arguments: { path: item.path } }],
    });
    messages.push({ role: 'tool', content: text, toolCallId: callId });
    index += 1;
  }
  // 真实对话轮次（含自然冗余空白）
  messages.push({ role: 'user', content: '请分析上述文件并给出改进建议。   \n\n\n\n' });
  messages.push({ role: 'assistant', content: '已分析。\n\n\n\n结论如下：见上文。  ' });
  messages.push({ role: 'user', content: '继续。' });
  return messages;
}

/** 整段是否为合法 JSON（用于口径 ③）。 */
function isWholeJson(text) {
  const trimmed = text.trim();
  const jsonLike =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!jsonLike) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

const messages = buildMessages();
const estimator = new TokenEstimator();
const compressor = new DeterministicCompressor();

/** 只统计可收缩角色（system 由 harness 编排、不由本条链路改动）。 */
const shrinkable = messages.filter((m) => m.role !== 'system');
const bytesOf = (list) => list.reduce((sum, m) => sum + byteLength(m.content), 0);

const beforeBytes = bytesOf(shrinkable);
const beforeTokens = estimator.estimateMessages(shrinkable);

// —— 机制归因：分别看「只折叠空行」「只紧凑 JSON」「两者（=接线口径）」 ——
let collapseSaved = 0;
let minifySaved = 0;
for (const m of shrinkable) {
  const raw = m.content;
  collapseSaved += byteLength(raw) - byteLength(compressor.collapseBlankLines(raw));
  minifySaved += byteLength(raw) - byteLength(compressor.minifyJsonBlock(raw));
}

// —— 口径 ①：未达阈值（长会话常态），接线前 vs 接线后 ——
const HUGE = 10_000_000;
const plain = await new ContextCompactor(undefined, {
  maxTokens: HUGE,
  keepRecent: 6,
  deterministicShrink: false,
}).compact(messages);
const shrunk = await new ContextCompactor(undefined, {
  maxTokens: HUGE,
  keepRecent: 6,
  deterministicShrink: true,
}).compact(messages);
if (plain.compacted !== false || shrunk.compacted !== false) {
  throw new Error('口径 ① 期望未达阈值（compacted:false），阈值设置有误');
}
const dropSystem = (list) => list.filter((m) => m.role !== 'system');
const plainBytes = bytesOf(dropSystem(plain.messages));
const shrunkBytes = bytesOf(dropSystem(shrunk.messages));

// —— 口径 ②：触达压缩阈值，只比较**保留下来**的非 system 消息 ——
const tightOff = await new ContextCompactor(undefined, {
  maxTokens: 2000,
  keepRecent: 6,
  deterministicShrink: false,
}).compact(messages);
const tightOn = await new ContextCompactor(undefined, {
  maxTokens: 2000,
  keepRecent: 6,
  deterministicShrink: true,
}).compact(messages);
if (!tightOff.compacted || !tightOn.compacted) {
  throw new Error('口径 ② 期望触达压缩（compacted:true），语料不足以触发');
}
const retainedPlainBytes = bytesOf(dropSystem(tightOff.messages));
const retainedShrunkBytes = bytesOf(dropSystem(tightOn.messages));

// —— 口径 ③：只看整段 JSON 型工具输出（机制射程） ——
const jsonMessages = shrinkable.filter((m) => isWholeJson(m.content));
const jsonBeforeBytes = bytesOf(jsonMessages);
const jsonAfterBytes = jsonMessages.reduce(
  (sum, m) => sum + byteLength(compressor.shrinkLossless(m.content)),
  0,
);

const pct = (from, to) => (from === 0 ? 0 : round((1 - to / from) * 100, 2));

const perMessage = shrinkable.map((m) => {
  const before = byteLength(m.content);
  const after = byteLength(compressor.shrinkLossless(m.content));
  return {
    role: m.role,
    json: isWholeJson(m.content),
    beforeBytes: before,
    afterBytes: after,
    savedPct: pct(before, after),
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: REAL_CORPUS.length - skipped.length, skipped, messages: messages.length },
  shrinkableBytes: beforeBytes,
  shrinkableTokensEstimated: beforeTokens,
  mechanism: {
    collapseOnlySavedBytes: collapseSaved,
    minifyJsonOnlySavedBytes: minifySaved,
    bothSavedBytes: beforeBytes - shrunkBytes,
  },
  view1BelowThreshold: {
    beforeBytes: plainBytes,
    afterBytes: shrunkBytes,
    savedBytes: plainBytes - shrunkBytes,
    savedPct: pct(plainBytes, shrunkBytes),
  },
  view2CompactedTail: {
    beforeBytes: retainedPlainBytes,
    afterBytes: retainedShrunkBytes,
    savedBytes: retainedPlainBytes - retainedShrunkBytes,
    savedPct: pct(retainedPlainBytes, retainedShrunkBytes),
  },
  view3JsonOutputsOnly: {
    messages: jsonMessages.length,
    beforeBytes: jsonBeforeBytes,
    afterBytes: jsonAfterBytes,
    savedPct: pct(jsonBeforeBytes, jsonAfterBytes),
  },
  perMessage,
};

console.log('=== 投影层确定性无损收缩：接线前后对照（真实仓库语料） ===');
console.log(
  `语料: ${report.corpus.files} 个真实文件 → ${report.corpus.messages} 条消息` +
    (skipped.length > 0 ? `（跳过 ${skipped.length}: ${skipped.join(', ')}）` : ''),
);
console.log(`可收缩内容: ${round(beforeBytes / 1024)} KB / ~${beforeTokens} token\n`);
console.log('机制归因（只统计可收缩角色）:');
console.log(`  仅折叠空行+行尾空白 : 省 ${collapseSaved} B`);
console.log(`  仅整段 JSON 紧凑化  : 省 ${minifySaved} B`);
console.log(`  两者叠加（接线口径）: 省 ${report.mechanism.bothSavedBytes} B\n`);
console.log('口径① 未达压缩阈值（长会话常态 ⇒ 每轮持续收益）:');
console.log(
  `  ${round(plainBytes / 1024)} KB → ${round(shrunkBytes / 1024)} KB   省 ${report.view1BelowThreshold.savedPct}%`,
);
console.log('口径② 触达压缩阈值（保留 tail ⇒ 压缩时收益）:');
console.log(
  `  ${round(retainedPlainBytes / 1024)} KB → ${round(retainedShrunkBytes / 1024)} KB   省 ${report.view2CompactedTail.savedPct}%`,
);
console.log(
  `口径③ 整段 JSON 型工具输出（${report.view3JsonOutputsOnly.messages} 条）: ` +
    `${round(jsonBeforeBytes / 1024)} KB → ${round(jsonAfterBytes / 1024)} KB   省 ${report.view3JsonOutputsOnly.savedPct}%`,
);
console.log('\n逐条消息节省率:');
for (const row of perMessage) {
  console.log(
    `  [${row.role.padEnd(9)}${row.json ? ' json' : '     '}] ` +
      `${String(round(row.beforeBytes / 1024)).padStart(7)} KB → ` +
      `${String(round(row.afterBytes / 1024)).padStart(7)} KB  ${String(row.savedPct).padStart(6)}%`,
  );
}

writeFileSync(
  new URL('./compaction-wiring.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote compaction-wiring.report.json');
