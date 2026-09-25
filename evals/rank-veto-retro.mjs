/**
 * 排序前置否决器 —— 回溯验证（retroactive validation）。
 *
 * 目的：否决器的价值在于「**提前**预判一条排序路不值得跑」。若它不能复盘本仓库已经付过学费的
 * 失败（稠密图 −6.1pp / 稀疏引用图多跳 −2.6pp），它就只是新的一层玄学。
 *
 * 本脚本做**回溯验证**而非「刷指标」：把已知失败的真实路由喂给否决器，
 * 检验其结论是否与已知实测结果一致。**不一致必须如实记录，不许调阈值凑结果。**
 *
 * ## 本脚本已经证伪过一版判据，经过留档
 *
 * 第一版「结构性退化」判据（谱隙大 / 稳态近均匀 / 度 Gini 低）在此**全军覆没**：
 * 真实稠密图实测谱隙 0.2795、稳态 KL 0.5219、有效支撑率 0.5934、度 Gini 0.482——
 * 一条都没触发，而该路已知 −6.1pp。**「PageRank 收敛至近均匀」这个既有解释是错的。**
 *
 * 同一次测量意外挖出真机理：图路由在 33 条查询上的 Top-14 跨查询平均重合度 **0.942**，
 * 而 BM25 仅 **0.058**——图排序不是退化，而是**对查询不敏感的常量偏置**。
 * 否决器据此改写主判据，本脚本随之改写。
 *
 * 用法：`node evals/rank-veto-retro.mjs`（需先 `tsc -p tsconfig.json` 产出 dist/）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ContextEngine } from '../dist/src/context/contextEngine.js';
import { Bm25Index } from '../dist/src/search/bm25Index.js';
import { CodeReferenceGraph } from '../dist/src/context/codeReferenceGraph.js';
import { CodeGraphIndex } from '../dist/src/context/codeGraphIndex.js';
import { RankVetoEvaluator, RankVetoOverlap } from '../dist/src/context/rankVeto/index.js';
import { LayeredCodeGraph } from '../dist/src/context/layeredCodeGraph.js';

/** 语料根目录（与生产口径一致）。 */
const SRC = 'src';

/** 文件预算（与召回评测口径一致）。 */
const FILE_K = 14;

/** 对照基准：BM25 已知有效，用于提供「有效路由」的不敏感度参照。 */
const BASELINE_ROUTE = 'BM25 文件路';

/**
 * 从召回评测脚本里抽取查询文本，避免两处语料漂移。
 *
 * @returns 查询字符串数组
 */
function loadQueries() {
  const src = readFileSync('evals/recall-codebase-real.mjs', 'utf8');
  const out = [];
  const re = /q:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * 取 BM25 文件路 Top-K。
 *
 * @param corpus 已索引语料
 * @param q 查询文本
 * @param k 文件预算
 * @returns 相对路径数组
 */
function bm25TopFiles(corpus, q, k) {
  return corpus.fileIndex
    .search(Bm25Index.tokenizeExpanded(q), k)
    .map((h) => corpus.files[h.id]?.rel)
    .filter((r) => typeof r === 'string');
}

/** PageRank 迭代轮数与阻尼（与 `codeReferenceGraph` 内部常量一致，保证口径相同）。 */
const GRAPH_ITERS = 24;
const DAMPING = 0.85;

/**
 * 为任意图构造 `GraphSignal` 形态的信号（复刻 `getGraphSignal` 的文件中心性聚合，
 * 使稠密图与稀疏图走上完全相同的评估路径）。
 *
 * @param corpus 已索引语料
 * @param graph 图
 * @returns `{ graph, edgeCount, fileCentrality }`
 */
function signalOf(corpus, graph) {
  const uniform = new Map();
  const inv = 1 / Math.max(corpus.symbols.length, 1);
  for (let i = 0; i < corpus.symbols.length; i++) uniform.set(i, inv);
  const scores = CodeGraphIndex.propagate(graph, uniform, GRAPH_ITERS, DAMPING);
  const fileCen = new Map();
  for (let i = 0; i < corpus.symbols.length; i++) {
    const f = corpus.symbols[i]?.file;
    if (f === undefined) continue;
    fileCen.set(f, (fileCen.get(f) ?? 0) + (scores[i] ?? 0));
  }
  let max = 0;
  for (const v of fileCen.values()) if (v > max) max = v;
  if (max > 0) for (const [k, v] of fileCen) fileCen.set(k, v / max);
  let edgeCount = 0;
  for (const es of graph.adj) edgeCount += es.length;
  return { graph, edgeCount, fileCentrality: fileCen };
}

/**
 * 取图路由 Top-K 文件（`file:` 前缀已剥离）。
 *
 * @param corpus 已索引语料
 * @param sig 图信号
 * @param q 查询文本
 * @param k 文件预算
 * @returns 相对路径数组
 */
function graphTopFiles(corpus, sig, q, k) {
  const seed = corpus.symbolIndex.search(Bm25Index.tokenizeExpanded(q), 40).map((h) => h.id);
  return CodeReferenceGraph.graphNeighborFileRoute(corpus, seed, sig)
    .slice(0, k)
    .map((id) => (id.startsWith('file:') ? id.slice(5) : id));
}

/**
 * 取**层化**图路由 Top-K 文件（T2 ① 候选）。
 *
 * 与 `graphTopFiles` 用同一套种子（符号路 BM25 Top-40），只有图不同，
 * 因此两者可直接对照。
 *
 * @param corpus 已索引语料
 * @param graph 层化图
 * @param q 查询文本
 * @param k 文件预算
 * @returns 相对路径数组
 */
function layeredTopFiles(corpus, graph, q, k) {
  const hits = corpus.symbolIndex.search(Bm25Index.tokenizeExpanded(q), 40);
  const seed = new Map(hits.map((h) => [h.id, h.score]));
  return LayeredCodeGraph.layeredFileRoute(corpus.symbols, graph, seed, k);
}

const t0 = Date.now();
// 本脚本确实要用 corpus.codeGraph（full 模式独有）⇒ 显式声明 light:false（默认已翻为 light）。
const corpus = ContextEngine.indexCorpus(SRC, { light: false });
console.log(
  `语料：${corpus.symbols.length} 符号 / ${corpus.files.length} 文件（索引 ${Date.now() - t0}ms）`,
);

const queries = loadQueries();
console.log(`查询：${queries.length} 条（自 evals/recall-codebase-real.mjs 抽取）\n`);

const evaluator = new RankVetoEvaluator();

// ── 基线：BM25 文件路（已知有效，作为有效路由形态的对照基准）──────────────
const baselineLists = queries.map((q) => bm25TopFiles(corpus, q, FILE_K));

// ── 候选 1：稠密图路由（`corpus.codeGraph` 即 buildCodeGraph 产物）──────────
// 与稀疏图共用同一套查询邻域扩散逻辑，仅图不同，故用 buildCodeGraph 的图手工跑一遍。
//
// `--selftest`：把稠密路由的探针**替换成 BM25 基线列表**，人为制造
// 「否决器对一条已知失败的路放行」的不一致，用来验证 `--gate` **真的会红**。
// 门禁若只验证过绿灯，等于没验证过。
const SELFTEST = process.argv.includes('--selftest');
const denseSig = signalOf(corpus, corpus.codeGraph);
const denseLists = SELFTEST
  ? baselineLists
  : queries.map((q) => graphTopFiles(corpus, denseSig, q, FILE_K));

// ── 候选 2：稀疏引用图路由（生产 opt-in 的第四路）────────────────────────
const sparseSig = CodeReferenceGraph.getGraphSignal(SRC, corpus);
const sparseLists = queries.map((q) => graphTopFiles(corpus, sparseSig, q, FILE_K));

/**
 * 评估并打印一条候选路由。
 *
 * @param label 路由名
 * @param graph 图（结构性诊断用）
 * @param candidateLists 候选探针列表
 * @param knownDeltaPp 已知实测 Δpp；`null` 表示新候选、尚无已知实测
 * @returns 报告
 */
function evaluateRoute(label, graph, candidateLists, knownDeltaPp) {
  const overlapSum = candidateLists.reduce(
    (s, list, i) => s + RankVetoOverlap.jaccardOverlap(baselineLists[i], list),
    0,
  );
  const report = evaluator.evaluate({
    graph,
    candidateProbeLists: candidateLists,
    baselineProbeLists: baselineLists,
  });
  const m = report.metrics;
  const knownText =
    knownDeltaPp === null
      ? '新候选，无已知实测'
      : `已知实测 ${knownDeltaPp > 0 ? '+' : ''}${knownDeltaPp}pp`;
  console.log(`\n── ${label}（${knownText}）`);
  console.log(
    `   查询不敏感度 ${m.queryInsensitivity.toFixed(4)}   基线(${BASELINE_ROUTE}) ${m.baselineQueryInsensitivity.toFixed(
      4,
    )}   比值 ${m.insensitivityRatio.toFixed(1)}×`,
  );
  console.log(
    `   与 BM25 Top-${FILE_K} 平均重合度 ${(overlapSum / candidateLists.length).toFixed(4)}`,
  );
  console.log(
    `   [诊断] 谱隙 ${m.spectralGap.toFixed(4)}  稳态KL ${m.uniformKl.toFixed(4)}  有效支撑率 ${m.effectiveSupportRatio.toFixed(
      4,
    )}  度Gini ${m.degreeGini.toFixed(3)}`,
  );
  console.log(`   结论：${report.verdict === 'veto' ? '❌ 否决（建议跳过该排序路）' : '✅ 放行'}`);
  for (const r of report.reasons) console.log(`     · ${r}`);
  for (const n of report.notes) console.log(`     ${n}`);
  return { report, avgOverlap: overlapSum / candidateLists.length };
}

const dense = evaluateRoute('稠密 buildCodeGraph 图路由', corpus.codeGraph, denseLists, -6.1);
const sparse = evaluateRoute('稀疏 codeReferenceGraph 图路由', sparseSig.graph, sparseLists, -2.6);

// ── 候选 3：层化图路由（T2 ① 新候选）——────────────────────────────────
// 尚无已知实测，因此**不进回溯一致率**，只由否决器做前置判定：
// 放行 ⇒ 值得跑完整召回评测；否决 ⇒ 直接放弃，省下整轮实验成本。
const tLay0 = Date.now();
const layeredGraph = LayeredCodeGraph.buildLayeredCodeGraph(corpus);
const layeredLists = queries.map((q) => layeredTopFiles(corpus, layeredGraph, q, FILE_K));
console.log(
  `\n[稀疏化] 稠密图 ${LayeredCodeGraph.edgeCountOf(corpus.codeGraph)} 边 → 层化图 ${LayeredCodeGraph.edgeCountOf(
    layeredGraph,
  )} 边（构建 ${Date.now() - tLay0}ms）`,
);
const layered = evaluateRoute('层化图路由（T2 ①）', layeredGraph, layeredLists, null);

// ── 反向对照：BM25 自己（已知有效，否决器必须放行，否则判据会误杀）────────
const selfCheck = evaluator.evaluate({
  candidateProbeLists: baselineLists,
  baselineProbeLists: baselineLists,
});
console.log(`\n── 反向对照：${BASELINE_ROUTE}（已知有效，必须放行）`);
console.log(`   查询不敏感度 ${selfCheck.metrics.queryInsensitivity.toFixed(4)}`);
console.log(`   结论：${selfCheck.verdict === 'veto' ? '❌ 否决（误杀！）' : '✅ 放行'}`);

// ── 回溯比对 ────────────────────────────────────────────────────────────
console.log('\n══════ 回溯比对（否决器结论 vs 已知实测） ══════');
const rows = [
  { name: '稠密图路由', verdict: dense.report.verdict, expect: 'veto', known: -6.1 },
  { name: '稀疏图路由', verdict: sparse.report.verdict, expect: 'veto', known: -2.6 },
  { name: BASELINE_ROUTE, verdict: selfCheck.verdict, expect: 'proceed', known: 0 },
];
let consistent = 0;
for (const r of rows) {
  const ok = r.verdict === r.expect;
  if (ok) consistent++;
  console.log(
    `${ok ? '✅' : '❌'} ${r.name.padEnd(22)} 否决器=${r.verdict.padEnd(7)} 期望=${r.expect.padEnd(7)} 已知Δ=${String(
      r.known,
    ).padStart(5)}pp  预判${ok ? '一致' : '不一致'}`,
  );
}
console.log(`\n回溯一致率：${consistent}/${rows.length}`);

// ── 新候选裁决：层化图路由值不值得跑完整召回评测 ─────────────────────────
console.log('\n══════ 新候选裁决（层化图路由，T2 ①） ══════');
console.log(`   否决器结论：${layered.report.verdict}`);
console.log(
  `   ⇒ ${
    layered.report.verdict === 'veto'
      ? '放弃完整召回评测（省下一轮实验成本），如实记为负结果'
      : '值得跑完整召回评测（同 corpus 开关隔离对照）'
  }`,
);

writeFileSync(
  'evals/rank-veto-retro.report.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      corpus: { symbols: corpus.symbols.length, files: corpus.files.length },
      queryCount: queries.length,
      fileK: FILE_K,
      baseline: { route: BASELINE_ROUTE, ...selfCheck.metrics, verdict: selfCheck.verdict },
      dense: {
        ...dense.report.metrics,
        avgOverlapWithBm25: dense.avgOverlap,
        verdict: dense.report.verdict,
        reasons: dense.report.reasons,
        notes: dense.report.notes,
      },
      sparse: {
        ...sparse.report.metrics,
        avgOverlapWithBm25: sparse.avgOverlap,
        verdict: sparse.report.verdict,
        reasons: sparse.report.reasons,
        notes: sparse.report.notes,
      },
      layered: {
        ...layered.report.metrics,
        avgOverlapWithBm25: layered.avgOverlap,
        verdict: layered.report.verdict,
        reasons: layered.report.reasons,
        notes: layered.report.notes,
        edgeCount: LayeredCodeGraph.edgeCountOf(layeredGraph),
        denseEdgeCount: LayeredCodeGraph.edgeCountOf(corpus.codeGraph),
        knownDeltaPp: null,
      },
      retro: { consistent, total: rows.length },
    },
    null,
    2,
  ),
  'utf8',
);
console.log('\n报告已写入 evals/rank-veto-retro.report.json');

// ── 门禁模式（`--gate`）───────────────────────────────────────────────────
// 只有**回溯一致率**参与判定：若否决器无法复盘已知失败，说明判据已失效，必须红。
// 新候裁决（层化图等）**不参与门禁**——它的结论本来就是待验证的，不该锁死 CI。
if (process.argv.includes('--gate')) {
  process.exitCode = consistent === rows.length ? 0 : 1;
  console.log(`[gate] 回溯一致率 ${consistent}/${rows.length} ⇒ exit ${process.exitCode}`);
}
