#!/usr/bin/env node
/**
 * 热路径**性能预算门禁**（2026-10-25，Wave 0 的最小落地）。
 *
 * ## 为什么需要它
 *
 * 本仓已有「门禁耗时预算」（`gateBudget.mjs`）与「首屏体积预算」（`webBundleBudget.mjs`），
 * 但**每步都要跑的运行时热路径**没有任何回归护栏：repo-map 全仓哈希、压缩器全量收缩、
 * SSE 分帧这些改动只要没红，谁也不知道下一个人是否把它们改回了 O(n²)。
 *
 * 本脚本只量**可离线复现、无外部进程**的三段（消费 `dist` 产物，与生产同代码路径）：
 *  1. `SseParser`：单个 200 KB 事件按 1 KB chunk 喂入的墙钟；
 *  2. `ToolExposurePlanner`：34 工具 `plan()` 的 warm 平均耗时；
 *  3. `DeterministicCompressor.shrinkLossless`：200 条消息的 warm 平均耗时。
 *
 * 阈值在 `scripts/perfBudget.json`（数据而非代码）。本机噪声大，取**多次最小值**；
 * 预算按「当前实测的 3–5 倍」留余量，只挡数量级回归（如 O(n²) 回来），不做微基准攀比。
 *
 * 用法：
 * ```bash
 * npm run build
 * node scripts/perfGate.mjs
 * node scripts/perfGate.mjs --json
 * ```
 *
 * 退出码：0 达标；1 超预算；2 dist 缺失（先 `npm run build`）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const BUDGET = JSON.parse(readFileSync(join(ROOT, 'scripts', 'perfBudget.json'), 'utf8'));
const DIST = join(ROOT, 'dist', 'src');
if (!existsSync(DIST)) {
  process.stderr.write(`✗ dist 缺失：${DIST}（先跑 npm run build）\n`);
  process.exit(2);
}

/**
 * 取 n 次运行的最小墙钟（ms）。噪声只会抬高样本，最小值是最少受干扰的估计。
 * @param {() => Promise<void> | void} fn 被测函数
 * @param {number} runs 运行次数
 * @returns {Promise<number>} 最小墙钟毫秒
 */
async function minOf(fn, runs = 5) {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** 把文本按固定字节切块包装成流（SSE 解析用）。 */
function chunkedStream(text, chunkSize) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.slice(index, index + chunkSize));
      }
      controller.close();
    },
  });
}

const { sseParser } = await import(pathToFileURL(join(DIST, 'adapters/model/sseParser.js')).href);
const { ToolExposurePlanner } = await import(
  pathToFileURL(join(DIST, 'core/toolExposurePlanner.js')).href
);
const { DeterministicCompressor } = await import(
  pathToFileURL(join(DIST, 'context/deterministicCompressor.js')).href
);
const { ContextCompactor } = await import(
  pathToFileURL(join(DIST, 'context/contextCompactor.js')).href
);
const { Bm25MemoryIndex } = await import(
  pathToFileURL(join(DIST, 'adapters/retrieval/bm25MemoryIndex.js')).href
);
const { ContextBreakdownEstimator } = await import(
  pathToFileURL(join(DIST, 'context/contextBreakdownEstimator.js')).href
);
const { ThreadPage } = await import(
  pathToFileURL(join(DIST, 'server/services/session/threadPage.js')).href
);

const payload = 'x'.repeat(200 * 1024);
const sseMs = await minOf(async () => {
  await sseParser.read(chunkedStream(`data: ${payload}\n\n`, 1024), () => undefined);
});

const tools = [
  ...new Set(ToolExposurePlanner.DEFAULT_CATEGORIES.flatMap((category) => category.tools)),
];
const toolTexts = new Map(
  tools.map((name) => [
    name,
    `${name} 执行工具，读取文件、运行测试、搜索代码、查询状态 `.repeat(3),
  ]),
);
const plannerInput = {
  taskText: '读取文件并运行测试，然后修改代码',
  tools,
  toolTexts,
};
ToolExposurePlanner.plan(plannerInput); // warmup
const plannerMs = await minOf(() => {
  for (let index = 0; index < 20; index += 1) ToolExposurePlanner.plan(plannerInput);
}, 3);

const compressor = new DeterministicCompressor();
const messages = Array.from(
  { length: 200 },
  (_, index) => `{\n  "i": ${String(index)},\n  "text": "${'x'.repeat(400)}"\n}\n\n\n`,
);
for (const message of messages) compressor.shrinkLossless(message); // warmup
const shrinkMs = await minOf(() => {
  for (const message of messages) compressor.shrinkLossless(message);
}, 3);

const headMessages = Array.from({ length: 1200 }, (_, index) => ({
  role: index % 3 === 0 ? 'assistant' : 'user',
  content: `message-${String(index)}-${'z'.repeat(900)}`,
}));
ContextCompactor.headFingerprint(headMessages); // warmup（单条片段缓存）
const fingerprintMs = await minOf(() => {
  ContextCompactor.headFingerprint(headMessages);
}, 5);

// F8：1 MB 会话首次建索引后，追加一条新事件再 search 不得全量重建。
const memory = new Bm25MemoryIndex();
for (let index = 0; index < 200; index += 1) {
  memory.index({
    id: `m${String(index)}`,
    sessionId: 's',
    seq: index,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `memory-${String(index)} ${'token '.repeat(800)}`,
    ts: '2026-10-25T00:00:00.000Z',
  });
}
memory.search('memory', 20); // 首次全量建索引
memory.index({
  id: 'm200',
  sessionId: 's',
  seq: 200,
  role: 'user',
  text: `memory-200 ${'token '.repeat(800)}`,
  ts: '2026-10-25T00:00:01.000Z',
});
const memoryMs = await minOf(() => {
  memory.search('memory', 20);
}, 5);

const breakdown = new ContextBreakdownEstimator();
const breakdownMessages = Array.from({ length: 1000 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${String(index)} ${'x'.repeat(200)}`,
}));
const breakdownTools = Array.from({ length: 34 }, (_, index) => ({
  name: `tool_${String(index)}`,
  description: 'd'.repeat(100),
  parameters: { type: 'object', properties: { x: { type: 'string' } } },
}));
const breakdownInput = {
  messages: breakdownMessages,
  tools: breakdownTools,
  baseFragmentCount: 1,
  windowTokens: 128_000,
};
breakdown.estimate(breakdownInput); // warm
const breakdownMs = await minOf(() => {
  breakdown.estimate(breakdownInput);
}, 5);

// S2：50k 事件大会话，取尾部 300 条并序列化（首屏 payload 的服务器侧成本）。
const threadEvents = Array.from({ length: 50_000 }, (_, index) => ({
  id: `e${String(index)}`,
  type: 'assistant',
  ts: '2026-10-25T00:00:00.000Z',
  payload: { content: `event-${String(index)}-${'x'.repeat(80)}` },
}));
ThreadPage.slice(threadEvents, 300); // warmup
const pageMs = await minOf(() => {
  const page = ThreadPage.slice(threadEvents, 300);
  JSON.stringify(page.items);
}, 5);

const report = {
  sseParser200KbAt1KbMs: Number(sseMs.toFixed(2)),
  plannerWarmMs: Number((plannerMs / 20).toFixed(2)),
  shrink200WarmMs: Number(shrinkMs.toFixed(2)),
  fingerprintWarmMs: Number(fingerprintMs.toFixed(3)),
  memorySearchWarmMs: Number(memoryMs.toFixed(3)),
  breakdownWarmMs: Number(breakdownMs.toFixed(3)),
  threadPage300Ms: Number(pageMs.toFixed(3)),
  budget: BUDGET,
};
const checks = [
  ['sseParser200KbAt1KbMs', report.sseParser200KbAt1KbMs],
  ['plannerWarmMs', report.plannerWarmMs],
  ['shrink200WarmMs', report.shrink200WarmMs],
  ['fingerprintWarmMs', report.fingerprintWarmMs],
  ['memorySearchWarmMs', report.memorySearchWarmMs],
  ['breakdownWarmMs', report.breakdownWarmMs],
  ['threadPage300Ms', report.threadPage300Ms],
];
const failed = checks.filter(([key, value]) => value > BUDGET[key]);

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ...report, ok: failed.length === 0 }, null, 2)}\n`);
} else {
  for (const [key, value] of checks) {
    const mark = value > BUDGET[key] ? '✗' : '✓';
    process.stdout.write(
      `${mark} ${key.padEnd(26)} ${String(value).padStart(8)} ms ｜ 预算 ≤ ${String(BUDGET[key])} ms\n`,
    );
  }
  process.stdout.write(
    `  · 场景：SSE 200 KB@1 KB chunk ｜ planner ${String(tools.length)} 工具 warm ｜ shrink 200 条 warm ｜ fingerprint 1200 条 warm ｜ memory 200 文档 warm ｜ breakdown 1000 消息 warm ｜ thread page 50k→300\n`,
  );
}
process.exit(failed.length === 0 ? 0 : 1);
