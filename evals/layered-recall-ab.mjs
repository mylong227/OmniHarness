/**
 * 层化图路由 —— 召回 AB 对照（T2 ① 的第二关）。
 *
 * ## 它在流程里的位置
 *
 * T2 ① 分两关，**先否决后评测**，避免为注定失败的路烧一整轮实验：
 *
 * ```
 * 第 1 关（已完成）：evals/rank-veto-retro.mjs  查询敏感度否决器
 *       层化图 0.038 / BM25 0.0585 ⇒ 放行（两条已知失败的图路 0.936 被正确否决）
 * 第 2 关（本脚本）：同 corpus、同 fileK、开关隔离的召回 AB
 *       BM25 基线 vs 层化图 vs 稠密图（负对照）vs 融合
 * ```
 *
 * ## 受控设计
 *
 * - **同 corpus**：全部路由跑在 `indexCorpus('src', { morph: true, light: true })` 上，
 *   与 `recall-codebase-real.mjs` 生产口径完全一致。
 * - **同 fileK**：统一 14（与历史 43.3% 基线同预算）。
 * - **开关隔离**：唯一变量是「用哪张图 / 融不融」，其余（种子、扩散轮数、阻尼、
 *   ground truth、召回定义）全部固定。
 * - **ground truth 不依赖被测路由**：用独立锚点字符串在语料里定位答案文件
 *   （沿用 `recall-codebase-real.mjs` 的防自证设计）。
 *
 * ## 预先承诺的失败判据（不许事后改）
 *
 * 1. 层化结果簇与 BM25 高度重合（Jaccard ≥ 0.7）⇒ 判定「复读」，放弃。
 * 2. 查询不敏感度 ≥ 0.5 ⇒ 判定「常量偏置」，放弃。（第 1 关已测：0.038，通过）
 * 3. 融合后召回**下降** ⇒ 如实记为**负结果**，不调参凑正。
 *
 * 用法：`node evals/layered-recall-ab.mjs`（需先 `tsc -p tsconfig.json` 产出 dist/）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { getRepoMapContext } = await importDist('context', 'repoMapContext.js');
const { indexCorpus } = await importDist('context', 'contextEngine.js');
const { tokenizeExpanded } = await importDist('search', 'bm25Index.js');
const { buildCodeGraph, propagate } = await importDist('context', 'codeGraph.js');
const { buildLayeredCodeGraph, edgeCountOf, layeredFileRoute } = await importDist(
  'context',
  'layeredCodeGraph.js',
);
const { RankVetoEvaluator, jaccardOverlap } = await importDist('context', 'rankVeto.js');

/** 语料根（与生产一致）。 */
const SRC = join(ROOT, 'src');

/** 文件预算：与历史 43.3% 基线同口径。 */
const FILE_K = 14;

/** 扩散参数：三张图共用，保证唯一变量是图本身。 */
const ITERS = 4;
const DAMPING = 0.85;

/** 种子宽度：符号路 BM25 Top-40。 */
const SEED_K = 40;

/**
 * 从召回评测脚本抽取「查询 + 独立锚点」，避免两处语料漂移。
 *
 * 逐行解析而非整段正则：`QUERIES` 里混用单行 `{ q: '..', anchor: '..' },`
 * 与多行（`{` / `q:` / `anchor:` / `}`）两种写法，整段正则会漏掉多行条目
 * （实测漏 3 条：33 → 30）。逐行解析对两种写法都成立。
 *
 * @returns `{ q, anchor }` 数组
 */
function loadQueries() {
  const lines = readFileSync(join(ROOT, 'evals', 'recall-codebase-real.mjs'), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const qm = /q:\s*'([^']+)'/.exec(lines[i] ?? '');
    if (qm === null) continue;
    const sameLine = /anchor:\s*'([^']+)'/.exec(lines[i] ?? '');
    let anchor = sameLine === null ? undefined : sameLine[1];
    if (anchor === undefined) {
      // 多行写法：anchor 在紧随其后的几行内。
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const am = /anchor:\s*'([^']+)'/.exec(lines[j] ?? '');
        if (am !== null) {
          anchor = am[1];
          break;
        }
      }
    }
    if (anchor !== undefined) out.push({ q: qm[1], anchor });
  }
  return out;
}

const t0 = Date.now();
const corpus = indexCorpus(SRC, { morph: true, light: true });

/** 按锚点定位 ground truth（不依赖任何被测路由）。 */
const groundTruth = (anchor) => {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
};

/** 从 repo-map 文本里抽出被呈现的文件集合。 */
const surfacedFiles = (ctx) => {
  const files = new Set();
  if (!ctx) return files;
  for (const line of ctx.split('\n')) {
    const m = line.match(/📄\s+(.+)/);
    if (m) files.add(m[1].trim());
  }
  return files;
};

/**
 * 通用图路由：给定图与种子，扩散后聚合成文件 Top-K。
 * 层化图与稠密图共用此实现，确保唯一变量是图。
 *
 * @param graph 图
 * @param seed 种子（符号 id → 分）
 * @param k 文件预算
 * @returns 文件相对路径数组
 */
function routeFromGraph(graph, seed, k) {
  const scores = propagate(graph, seed, ITERS, DAMPING);
  const byFile = new Map();
  for (let i = 0; i < scores.length; i += 1) {
    const f = corpus.symbols[i]?.file;
    if (f === undefined) continue;
    const v = scores[i] ?? 0;
    if (v <= 0) continue;
    const cur = byFile.get(f) ?? 0;
    if (v > cur) byFile.set(f, v);
  }
  return [...byFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([f]) => f);
}

let queries = loadQueries();
if (queries.length === 0) throw new Error('未能从 recall-codebase-real.mjs 抽取到查询');

console.log(
  `语料：${corpus.symbols.length} 符号 / ${corpus.files.length} 文件（索引 ${Date.now() - t0}ms）`,
);
console.log(`查询：${queries.length} 条（q + 独立锚点，自 recall-codebase-real.mjs 抽取）`);

// 锚点失效（GT=0）处理：本脚本记 0 分会拉低均值、原脚本会兜底成 100%，
// 两者都污染统计 ⇒ 一律**跳过并如实记录**，而不是静默吞掉。
const stale = [];
const usable = queries.filter(({ q, anchor }) => {
  if (groundTruth(anchor).size === 0) {
    stale.push({ q, anchor });
    return false;
  }
  return true;
});
if (stale.length > 0) {
  console.log(`\n⚠️  ${stale.length} 条查询的锚点在语料中已不存在（GT=0），已跳过：`);
  for (const s of stale) console.log(`     · q="${s.q}"  anchor="${s.anchor}"`);
  console.log(
    '     注意：这些失效锚点会让 evals/recall-codebase-real.mjs 的硬守卫直接抛错（既有债务，需另修）',
  );
}
queries = usable;
if (queries.length === 0) throw new Error('全部查询的锚点均失效，无法评测');

const tBuild = Date.now();
const denseGraph = buildCodeGraph(corpus);
const layeredGraph = buildLayeredCodeGraph(corpus);
console.log(
  `[图] 稠密 ${edgeCountOf(denseGraph)} 边 / 层化 ${edgeCountOf(layeredGraph)} 边（稀疏 ${(
    edgeCountOf(denseGraph) / Math.max(edgeCountOf(layeredGraph), 1)
  ).toFixed(1)}×，构建 ${Date.now() - tBuild}ms）\n`,
);

/** 每查询的评估结果。 */
const rows = [];
for (const { q, anchor } of queries) {
  const gt = groundTruth(anchor);
  const gtList = [...gt];

  // A) BM25 基线（生产路径，历史 43.3% 口径）
  const bm25Files = surfacedFiles(getRepoMapContext(SRC, q, { fileK: FILE_K }));

  // 种子：符号路 BM25 Top-40（三张图共用）
  const hits = corpus.symbolIndex.search(tokenizeExpanded(q), SEED_K);
  const seed = new Map(hits.map((h) => [h.id, h.score]));

  // B) 层化图路由（本轮候选）
  const layeredFiles = layeredFileRoute(corpus.symbols, layeredGraph, seed, FILE_K, ITERS, DAMPING);

  // C) 稠密图路由（负对照：已知 −6.1pp）
  const denseFiles = routeFromGraph(denseGraph, seed, FILE_K);

  const recallOf = (files) => {
    const set = files instanceof Set ? files : new Set(files);
    return gt.size ? gtList.filter((f) => set.has(f)).length / gt.size : 0;
  };

  rows.push({
    q,
    anchor,
    gtSize: gt.size,
    gtList,
    bm25: recallOf(bm25Files),
    layered: recallOf(layeredFiles),
    dense: recallOf(denseFiles),
    bm25Files: [...bm25Files],
    layeredFiles,
    denseFiles,
  });
}

/** 平均召回（百分点）。 */
const avg = (key) => (rows.reduce((s, r) => s + r[key], 0) / rows.length) * 100;

const bm25Avg = avg('bm25');
const layeredAvg = avg('layered');
const denseAvg = avg('dense');

console.log('══════ 单路由召回（fileK=' + FILE_K + '，' + rows.length + ' 查询） ══════');
console.log(`   BM25 基线（生产路径）      ${bm25Avg.toFixed(1)}%`);
console.log(
  `   层化图路由（本轮候选）     ${layeredAvg.toFixed(1)}%   Δ ${(layeredAvg - bm25Avg >= 0 ? '+' : '') + (layeredAvg - bm25Avg).toFixed(1)}pp`,
);
console.log(
  `   稠密图路由（负对照）       ${denseAvg.toFixed(1)}%   Δ ${(denseAvg - bm25Avg >= 0 ? '+' : '') + (denseAvg - bm25Avg).toFixed(1)}pp`,
);

// ── 融合扫描：BM25 保护位 N + 层化探索位 M，N + M = FILE_K ──────────────────
console.log('\n══════ 融合扫描（BM25 保护 N 位 + 层化探索 M 位，N+M=' + FILE_K + '） ══════');
const bm25Ranked = rows.map((r) => r.bm25Files.slice(0, FILE_K));
const layeredRanked = rows.map((r) => r.layeredFiles.slice(0, FILE_K));

const fusion = [];
for (let m = 0; m <= FILE_K; m += 2) {
  const nSlots = FILE_K - m;
  let sum = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const merged = new Set([...bm25Ranked[i].slice(0, nSlots), ...layeredRanked[i].slice(0, m)]);
    const gt = [...groundTruth(rows[i].anchor)];
    sum += gt.length ? gt.filter((f) => merged.has(f)).length / gt.length : 0;
  }
  const r = (sum / rows.length) * 100;
  fusion.push({ bm25Slots: nSlots, layeredSlots: m, recall: r });
  console.log(
    `   BM25 ${String(nSlots).padStart(2)} + 层化 ${String(m).padStart(2)}  →  ${r.toFixed(
      1,
    )}%   Δ ${(r - bm25Avg >= 0 ? '+' : '') + (r - bm25Avg).toFixed(1)}pp`,
  );
}
fusion.sort((a, b) => b.recall - a.recall);
const best = fusion[0];

/**
 * 对「融合 vs 基线」的增益做 bootstrap 重采样，判断增益是否可能是噪声。
 *
 * 融合扫描在 32 条查询上非单调（M=6 时 −3.5pp、M=10 时 +1.1pp、M=12 时 −5.3pp），
 * 这种曲线本身就暗示差值在噪声量级。**不许直接报点估计**。
 *
 * @param nSlots BM25 保护位
 * @param m 层化探索位
 * @param rounds 重采样次数
 * @returns `{ mean, lo, hi }`：增益百分点均值与 95% 置信区间
 */
function bootstrapGain(nSlots, m, rounds = 2000) {
  const n = rows.length;
  const diffs = new Array(rounds);
  for (let b = 0; b < rounds; b += 1) {
    let sBase = 0;
    let sFuse = 0;
    for (let i = 0; i < n; i += 1) {
      const k = Math.floor(Math.random() * n);
      const r = rows[k];
      const gt = r.gtList;
      if (gt.length === 0) continue;
      const base = new Set(bm25Ranked[k].slice(0, FILE_K));
      const fuse = new Set([...bm25Ranked[k].slice(0, nSlots), ...layeredRanked[k].slice(0, m)]);
      sBase += gt.filter((f) => base.has(f)).length / gt.length;
      sFuse += gt.filter((f) => fuse.has(f)).length / gt.length;
    }
    diffs[b] = ((sFuse - sBase) / n) * 100;
  }
  diffs.sort((a, b) => a - b);
  return {
    mean: diffs.reduce((a, b) => a + b, 0) / rounds,
    lo: diffs[Math.floor(0.025 * rounds)],
    hi: diffs[Math.floor(0.975 * rounds)],
  };
}

const boot = bootstrapGain(best.bm25Slots, best.layeredSlots);
const ciCrossesZero = boot.lo <= 0 && boot.hi >= 0;
console.log(
  `\n[噪声检验] 最优融合增益 bootstrap 95% CI = [${boot.lo.toFixed(2)}, ${boot.hi.toFixed(
    2,
  )}]pp，均值 ${boot.mean.toFixed(2)}pp ⇒ ${
    ciCrossesZero ? '⚠️ 区间跨 0，增益与噪声不可区分' : '区间不跨 0'
  }`,
);

// ── 增益是「普遍提升」还是「单点击穿」─────────────────────────────────────
const tally = { up: 0, down: 0, flat: 0 };
for (const r of rows) {
  const d = r.layered - r.bm25;
  if (d > 1e-9) tally.up += 1;
  else if (d < -1e-9) tally.down += 1;
  else tally.flat += 1;
}
console.log(
  `\n单查询分布（层化 vs BM25）：提升 ${tally.up} / 持平 ${tally.flat} / 下降 ${tally.down}`,
);

// ── 失败判据 ①：与 BM25 簇是否复读 ────────────────────────────────────────
const evaluator = new RankVetoEvaluator();
const vetoReport = evaluator.evaluate({
  graph: layeredGraph,
  candidateProbeLists: layeredRanked,
  baselineProbeLists: bm25Ranked,
});
const overlapAvg =
  layeredRanked.reduce((s, list, i) => s + jaccardOverlap(bm25Ranked[i], list), 0) /
  layeredRanked.length;

console.log('\n══════ 预先承诺的失败判据 ══════');
console.log(
  `   ① 与 BM25 簇重合度 ${overlapAvg.toFixed(4)} ${
    overlapAvg >= 0.7 ? '≥ 0.7 ⇒ ❌ 判定复读，放弃' : '< 0.7 ⇒ ✅ 通过（不是复读）'
  }`,
);
console.log(
  `   ② 查询不敏感度 ${vetoReport.metrics.queryInsensitivity.toFixed(4)} ${
    vetoReport.metrics.queryInsensitivity >= 0.5
      ? '≥ 0.5 ⇒ ❌ 判定常量偏置，放弃'
      : '< 0.5 ⇒ ✅ 通过'
  }`,
);
console.log(
  `   ③ 最优融合召回 ${best.recall.toFixed(1)}% vs 基线 ${bm25Avg.toFixed(1)}% ⇒ ${
    best.recall > bm25Avg ? '点估计为正' : best.recall === bm25Avg ? '⚠️ 持平' : '❌ 下降'
  }；但 bootstrap 95% CI 跨 0 ⇒ ${
    ciCrossesZero ? '❌ 增益不可置信，判为无增益（负结果）' : '✅ 增益可置信'
  }`,
);

// ── 验收：T2 零成本线 BM25 43.3% → ≥50% ────────────────────────────────────
const TARGET = 50;
console.log('\n══════ T2 零成本线验收（BM25 43.3% → ≥50%） ══════');
console.log(
  `   本轮实测最优 ${best.recall.toFixed(1)}%  ⇒  ${best.recall >= TARGET ? '✅ 达标' : '❌ 未达标'}`,
);

writeFileSync(
  join(ROOT, 'evals', 'layered-recall-ab.report.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      corpus: { symbols: corpus.symbols.length, files: corpus.files.length },
      queryCount: rows.length,
      staleQueries: stale.map((s) => ({ q: s.q, anchor: s.anchor })),
      fileK: FILE_K,
      iters: ITERS,
      damping: DAMPING,
      seedK: SEED_K,
      graphs: {
        denseEdges: edgeCountOf(denseGraph),
        layeredEdges: edgeCountOf(layeredGraph),
        sparsification: edgeCountOf(denseGraph) / Math.max(edgeCountOf(layeredGraph), 1),
      },
      recall: {
        bm25: bm25Avg,
        layered: layeredAvg,
        dense: denseAvg,
        bestFusion: best.recall,
        bestFusionSlots: { bm25: best.bm25Slots, layered: best.layeredSlots },
      },
      fusionScan: fusion,
      bootstrap: { ...boot, ciCrossesZero, rounds: 2000 },
      tally,
      failureCriteria: {
        clusterOverlap: overlapAvg,
        clusterOverlapPass: overlapAvg < 0.7,
        queryInsensitivity: vetoReport.metrics.queryInsensitivity,
        queryInsensitivityPass: vetoReport.metrics.queryInsensitivity < 0.5,
        targetRecall: TARGET,
        targetPass: best.recall >= TARGET,
      },
      perQuery: rows.map((r) => ({
        q: r.q,
        anchor: r.anchor,
        gtSize: r.gtSize,
        bm25: r.bm25,
        layered: r.layered,
        dense: r.dense,
      })),
    },
    null,
    2,
  ),
  'utf8',
);
console.log('\n报告已写入 evals/layered-recall-ab.report.json');
