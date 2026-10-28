#!/usr/bin/env node
/**
 * 间隔效应增益探针（2026-10-28，配合 docs/NATURE_INSPIRED_RND_2026-10-27.md §1.4 预注册规则）。
 *
 * ## 回答什么问题
 *
 * `OMNI_MEMORY_FORGETTING=1`（间隔重复排序）相对关闭（全局统一半衰期）在冻结查询集上的
 * **MRR 配对差**与配对 bootstrap 95% CI——决定「是否提案默认开启」的数据来源。
 *
 * ## 口径（诚实边界，读后再跑）
 *
 * - 语料：**合成**（确定性种子：240 条事实、词表拼接文本、时间戳按种子扰动）。
 *   两种 GT 变体分开报告、分开判 CI：
 *   1. `content`：相关事实按**内容**指定、时间戳随机——测「时间噪声下 ON 是否伤排序」
 *      （机制稳健性；此处 Δ 应≈0，显著为负即机制有损）；
 *   2. `recency`：相关事实同时是「模拟历史里最近被使用」的——机制假设的直接检验
 *      （保持率与相关性相关时 ON 应获益；**这是机制方向性证明，不是生产增益**）。
 * - 统计：配对 bootstrap 95% CI（2000 次重采样，固定种子 ⇒ 可复现）。
 * - **裁决口径（预注册）**：`recency` 显著为正 **且** `content` 不显著为负 ⇒ 可提交
 *   「默认开启」提案（仍须人工复核 + 全量回归）；否则保持默认关。
 * - 本探针不使用任何真实用户数据；生产增益结论仍需真实会话语料（本探针给不了）。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`（本探针 import `dist/src/adapters/memory/**`）。
 *
 * ## 用法
 *
 * ```bash
 * npm run build
 * node tools/probes/memorySpacingLift.mjs --facts=240 --queries=30 --json=report.json
 * ```
 *
 * ## 诚实边界
 *
 * - 合成语料 + 合成 GT：证明的是**机制方向性**与**时间噪声稳健性**，不是生产检索质量；
 * - `content` 变体的 GT 不含时间信息 ⇒ 它对 ON 是「无信息增益」场景，Δ≈0 即达标；
 * - 强化是**序列化**发生的（ON 跑 30 条查询的过程本身在写回稳定度）——这正是真实使用形态，
 *   但意味着结果对查询顺序敏感（顺序已冻结进种子，可复现）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeArgs } from './_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

// 参数解析排在 dist 动态 import **之前**（理由见 `_args.mjs` 头注释：旗标错不该被
// "缺少编译产物"盖住）。
const a = probeArgs({
  values: { facts: '240', queries: '30', json: '' },
});
const FACTS = Number(a.facts);
const QUERIES = Number(a.queries);
const JSON_OUT = String(a.json);
const SEED = 20261028;
const TOPK = 5;
const BOOTSTRAP = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
if (!Number.isInteger(FACTS) || FACTS < 20) {
  console.error('✗ --facts 必须是 ≥20 的整数');
  process.exit(2);
}
if (!Number.isInteger(QUERIES) || QUERIES < 5) {
  console.error('✗ --queries 必须是 ≥5 的整数');
  process.exit(2);
}

let FileLongTermMemory;
try {
  ({ FileLongTermMemory } = await importDist('adapters', 'memory', 'fileLongTermMemory.js'));
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`（本探针需要 dist/src/adapters/memory/**）。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

/** 线性同余伪随机（确定性；不依赖 Math.random）。 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const VOCAB = [
  'deploy',
  'rollback',
  'checkpoint',
  'workflow',
  'pipeline',
  'cache',
  'index',
  'config',
  'workspace',
  'session',
  'token',
  'budget',
  'policy',
  'sandbox',
  'approval',
  'memory',
  'recall',
  'test',
  'build',
  'release',
  'skill',
  'plugin',
  'browser',
  'agent',
  'context',
  'compaction',
  'spill',
  'attachment',
  'telemetry',
  'evolution',
];

/**
 * 合成语料：facts + queries + 每查询的相关事实 id 集（GT 机械推出：文本含全部查询词）。
 * @param {() => number} rand 伪随机源（调用方保证同种子同序列）。
 * @param {string} variant 'content'（时间戳随机）/ 'recency'（半数事实带新鲜 lastRecallAt）。
 * @returns {{ now: number, facts: object[], queries: { words: string[], relevant: string[] }[] }} 语料。
 */
function buildCorpus(rand, variant) {
  const now = Date.parse('2026-10-28T00:00:00.000Z');
  const facts = [];
  for (let i = 0; i < FACTS; i += 1) {
    const words = Array.from({ length: 8 }, () => VOCAB[Math.floor(rand() * VOCAB.length)]);
    const ageDays = rand() * 180;
    const fact = {
      id: `f${i}`,
      text: words.join(' '),
      importance: 1 + Math.floor(rand() * 5),
      createdAt: new Date(now - ageDays * DAY_MS).toISOString(),
      sessionId: 'probe',
      source: 'tool',
    };
    // recency 变体：给一半事实构造「最近被使用」的模拟历史（lastRecallAt 新鲜）。
    if (variant === 'recency' && i % 2 === 0) {
      fact.lastRecallAt = new Date(now - rand() * 2 * DAY_MS).toISOString();
    }
    facts.push(fact);
  }
  const queries = [];
  for (let q = 0; q < QUERIES; q += 1) {
    const words = Array.from({ length: 3 }, () => VOCAB[Math.floor(rand() * VOCAB.length)]);
    queries.push({
      words,
      relevant: facts.filter((f) => words.every((w) => f.text.includes(w))).map((f) => f.id),
    });
  }
  return { now, facts, queries };
}

/**
 * 构造一个真实 FileLongTermMemory（临时 JSONL；时钟冻结在语料 now）。
 * @param {string} tag 临时目录标签。
 * @param {{ now: number, facts: object[] }} corpus 语料。
 * @returns {{ memory: object, cleanup: () => void }} 记忆实例与清理函数。
 */
function makeMemory(tag, corpus) {
  const path = join(mkdtempSync(join(tmpdir(), tag)), 'mem.jsonl');
  const memory = new FileLongTermMemory(path, undefined, 90, () => corpus.now);
  for (const fact of corpus.facts) {
    memory.remember({ ...fact });
  }
  return { memory, cleanup: () => rmSyncTemp(path) };
}

/** 临时目录清理（尽力而为；失败交给系统临时目录策略）。 */
function rmSyncTemp(path) {
  try {
    rmSync(join(path, '..'), { recursive: true, force: true });
  } catch {
    // 清理失败不影响读数。
  }
}

/**
 * 跑一遍查询集，返回每查询的 MRR。
 * @param {object} memory 记忆实例。
 * @param {{ words: string[], relevant: string[] }[]} queries 查询集。
 * @returns {number[]} MRR 序列（与查询同序）。
 */
function runQueries(memory, queries) {
  return queries.map((query) => {
    const ranked = memory.recall(query.words.join(' '), TOPK);
    const rank = ranked.findIndex((f) => query.relevant.includes(f.id));
    return rank === -1 ? 0 : 1 / (rank + 1);
  });
}

/**
 * 配对 bootstrap 95% CI（固定种子重采样）。
 * @param {number[]} baseline OFF 的逐查询 MRR。
 * @param {number[]} treatment ON 的逐查询 MRR。
 * @param {number} [iterations] 重采样次数。
 * @returns {{ mean: number, lo: number, hi: number, significant: boolean }} 统计。
 */
function pairedBootstrap(baseline, treatment, iterations = BOOTSTRAP) {
  const n = Math.min(baseline.length, treatment.length);
  const deltas = Array.from({ length: n }, (_, i) => treatment[i] - baseline[i]);
  const rand = lcg(SEED);
  const means = [];
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += deltas[Math.floor(rand() * n)];
    }
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor(0.025 * iterations)];
  const hi = means[Math.floor(0.975 * iterations)];
  const mean = deltas.reduce((x, y) => x + y, 0) / n;
  return { mean, lo, hi, significant: lo > 0 };
}

const report = { seed: SEED, facts: FACTS, queries: QUERIES, topk: TOPK, variants: {} };
for (const variant of ['content', 'recency']) {
  const corpus = buildCorpus(lcg(SEED), variant);
  process.env['OMNI_MEMORY_FORGETTING'] = '';
  delete process.env['OMNI_MEMORY_FORGETTING'];
  const off = makeMemory('omni-spacing-probe-off-', corpus);
  const baseline = runQueries(off.memory, corpus.queries);
  off.cleanup();
  process.env['OMNI_MEMORY_FORGETTING'] = '1';
  const on = makeMemory('omni-spacing-probe-on-', corpus);
  const treatment = runQueries(on.memory, corpus.queries);
  on.cleanup();
  delete process.env['OMNI_MEMORY_FORGETTING'];
  const ci = pairedBootstrap(baseline, treatment);
  const mrr = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  report.variants[variant] = {
    mrrOff: Number(mrr(baseline).toFixed(4)),
    mrrOn: Number(mrr(treatment).toFixed(4)),
    deltaMean: Number(ci.mean.toFixed(4)),
    ci95: [Number(ci.lo.toFixed(4)), Number(ci.hi.toFixed(4))],
    significantPositive: ci.significant,
  };
}
// 裁决口径（预注册）：recency 变体显著为正 且 content 变体不显著为负。
const content = report.variants.content;
const verdict =
  report.variants.recency.significantPositive && !(content.ci95[0] < 0 && content.deltaMean < 0)
    ? 'PASS：可提交「默认开启」提案（仍须人工复核 + 全量回归）'
    : 'HOLD：保持默认关（未过两关；登记机制可用、增益未证）';
report.verdict = verdict;
if (JSON_OUT !== '') {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
