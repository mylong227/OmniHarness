/**
 * 层化图软融合 —— 召回 AB 对照（E4 深化，D6 第二关）。
 *
 * ## 它与 layered-recall-ab.mjs 的关系
 *
 * `evals/layered-recall-ab.mjs` 是**负结果留档**：层化图此前作「替换」BM25 用（layeredFileRoute
 * 只靠符号种子在稀疏图上扩散、丢掉整文件词法命中），file recall@14 实测 **−9.1pp**。那份报告
 * 保持不动，作为「图本身不废、是方法学错」的实证锚点。
 *
 * 本脚本测的是 **E4 修正后的打法 —— 软融合（fusion-not-replace）**：层化图扩散分并入
 * `query` 的 fileScore 的 max，文件 BM25 始终为地板项（绝不丢弃）。即 `getRepoMapContext`
 * 开启 `{ layered: true }` 后的真实生产路径变体。
 *
 * ## 受控设计（与 layered-recall-ab.mjs 同口径，保证可比）
 *
 * - **同 corpus**：`indexCorpus('src', { morph: true, light: true })`，与生产一致。
 * - **同 fileK**：14（与历史基线的等预算）。
 * - **开关隔离**：唯一变量是「开不开层化软融合」，其余（种子、扩散轮数、阻尼、ground truth、
 *   召回定义）全部固定。
 * - **ground truth 不依赖被测路由**：用独立锚点字符串在语料里定位答案文件。
 *
 * ## 验收（E4 条目原文：同 corpus AB ≥ +5pp 或诚实判负留档）
 *
 * 1. 融合召回 ≥ 基线 +5pp（点估计）；
 * 2. 增益的 bootstrap 95% CI **不跨 0**（增益与噪声可区分）；
 * 3. 满足 1∧2 ⇒ E4 深化成功（可翻生产默认）；否则诚实记为负结果。
 *
 * 用法：`node evals/layered-fusion-ab.mjs`（需先 `npm run build` 产出 dist/）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
/** repo-map 生产接入器实例（原模块级包装函数已随重命名移除，统一走实例方法）。 */
const repoMap = new RepoMapContextEngine();
const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { LayeredCodeGraph } = await importDist('context', 'layeredCodeGraph.js');
const { RankVetoEvaluator, jaccardOverlap } = await importDist('context', 'rankVeto', 'index.js');

/** 语料根（与生产一致）。 */
const SRC = join(ROOT, 'src');

/** 文件预算：与历史基线同口径。 */
const FILE_K = 14;

/** 扩散参数（与 layered-recall-ab.mjs 一致）。 */
const ITERS = 4;
const DAMPING = 0.85;

/**
 * 从召回评测脚本抽取「查询 + 独立锚点」（逐行解析，兼容单行/多行写法）。
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
const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });

/** 按锚点定位 ground truth（不依赖任何被测路由）。 */
const groundTruth = (anchor) => {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
};

/** 从 repo-map 文本里抽出被呈现的文件集合（数组，便于 bootstrap 切片）。 */
const surfacedFiles = (ctx) => {
  const files = [];
  if (!ctx) return files;
  for (const line of ctx.split('\n')) {
    const m = line.match(/📄\s+(.+)/);
    if (m) files.push(m[1].trim());
  }
  return files;
};

let queries = loadQueries();
if (queries.length === 0) throw new Error('未能从 recall-codebase-real.mjs 抽取到查询');

console.log(
  `语料：${corpus.symbols.length} 符号 / ${corpus.files.length} 文件（索引 ${Date.now() - t0}ms）`,
);
console.log(`查询：${queries.length} 条（q + 独立锚点，自 recall-codebase-real.mjs 抽取）`);

// 锚点失效（GT=0）处理：跳过并如实记录，不污染统计。
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
}
queries = usable;
if (queries.length === 0) throw new Error('全部查询的锚点均失效，无法评测');

const tBuild = Date.now();
const layeredGraph = LayeredCodeGraph.buildLayeredCodeGraph(corpus);
console.log(
  `[图] 层化 ${LayeredCodeGraph.edgeCountOf(layeredGraph)} 边（稀疏；构建 ${Date.now() - tBuild}ms，query 内另走 WeakMap 缓存）\n`,
);

/** 每查询的评估结果。 */
const rows = [];
for (const { q, anchor } of queries) {
  const gt = groundTruth(anchor);
  const gtList = [...gt];

  // A) BM25 基线（生产路径，layered 关）。
  const bm25Files = surfacedFiles(repoMap.getRepoMapContext(SRC, q, { fileK: FILE_K }));

  // B') 层化图软融合（E4 修正打法，layered 开）。
  const fusionFiles = surfacedFiles(
    repoMap.getRepoMapContext(SRC, q, { fileK: FILE_K, layered: true }),
  );

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
    fusion: recallOf(fusionFiles),
    bm25Files: [...bm25Files],
    fusionFiles,
  });
}

/** 平均召回（百分点）。 */
const avg = (key) => (rows.reduce((s, r) => s + r[key], 0) / rows.length) * 100;

const bm25Avg = avg('bm25');
const fusionAvg = avg('fusion');
const delta = fusionAvg - bm25Avg;

console.log('══════ 软融合 vs BM25 基线（fileK=' + FILE_K + '，' + rows.length + ' 查询） ══════');
console.log(`   BM25 基线（生产路径）      ${bm25Avg.toFixed(1)}%`);
console.log(
  `   层化图软融合（E4）        ${fusionAvg.toFixed(1)}%   Δ ${
    delta >= 0 ? '+' : ''
  }${delta.toFixed(1)}pp`,
);

/**
 * 对「融合 vs 基线」的增益做 bootstrap 重采样，判断增益是否可能是噪声。
 * @param rounds 重采样次数
 * @returns `{ mean, lo, hi }`：增益百分点均值与 95% 置信区间
 */
function bootstrapGain(rounds = 2000) {
  const n = rows.length;
  const bm25Ranked = rows.map((r) => r.bm25Files.slice(0, FILE_K));
  const fusionRanked = rows.map((r) => r.fusionFiles.slice(0, FILE_K));
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
      const fuse = new Set(fusionRanked[k].slice(0, FILE_K));
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

const boot = bootstrapGain(2000);
const ciCrossesZero = boot.lo <= 0 && boot.hi >= 0;
console.log(
  `\n[噪声检验] 增益 bootstrap 95% CI = [${boot.lo.toFixed(2)}, ${boot.hi.toFixed(
    2,
  )}]pp，均值 ${boot.mean.toFixed(2)}pp ⇒ ${
    ciCrossesZero ? '⚠️ 区间跨 0，增益与噪声不可区分' : '✅ 区间不跨 0'
  }`,
);

// ── 增益是「普遍提升」还是「单点击穿」─────────────────────────────────────
const tally = { up: 0, down: 0, flat: 0 };
for (const r of rows) {
  const d = r.fusion - r.bm25;
  if (d > 1e-9) tally.up += 1;
  else if (d < -1e-9) tally.down += 1;
  else tally.flat += 1;
}
console.log(
  `\n单查询分布（软融合 vs BM25）：提升 ${tally.up} / 持平 ${tally.flat} / 下降 ${tally.down}`,
);

// ── 与 BM25 簇重合度（软融合天然高重合，因为是「增强」而非「另起一路」）──────
const fusionRanked = rows.map((r) => r.fusionFiles.slice(0, FILE_K));
const bm25Ranked = rows.map((r) => r.bm25Files.slice(0, FILE_K));
const overlapAvg =
  fusionRanked.reduce((s, list, i) => s + jaccardOverlap(bm25Ranked[i], list), 0) /
  fusionRanked.length;
console.log(
  `\n与 BM25 簇重合度 ${overlapAvg.toFixed(4)}（软融合为增强路，高重合是预期，不作为复读判据）`,
);

// ── 查询不敏感度（D6 第 1 关否决器同口径，信息性）─────────────────────────
const evaluator = new RankVetoEvaluator();
const vetoReport = evaluator.evaluate({
  graph: layeredGraph,
  candidateProbeLists: fusionRanked,
  baselineProbeLists: bm25Ranked,
});
console.log(
  `查询不敏感度 ${vetoReport.metrics.queryInsensitivity.toFixed(4)} ${
    vetoReport.metrics.queryInsensitivity >= 0.5 ? '≥ 0.5 ⇒ ❌ 常量偏置' : '< 0.5 ⇒ ✅ 通过'
  }`,
);

// ── E4 验收：≥ +5pp 且 bootstrap CI 不跨 0 ─────────────────────────────────
const THRESHOLD_PP = 5;
const pass = delta >= THRESHOLD_PP && !ciCrossesZero;
console.log('\n══════ E4 验收（同 corpus AB ≥ +5pp 且 CI 不跨 0） ══════');
console.log(
  `   点估计 Δ = ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp ${
    delta >= THRESHOLD_PP ? '✅ ≥ +5pp' : `❌ < +${THRESHOLD_PP}pp`
  }`,
);
console.log(
  `   bootstrap 95% CI [${boot.lo.toFixed(2)}, ${boot.hi.toFixed(2)}]pp ${
    ciCrossesZero ? '❌ 跨 0' : '✅ 不跨 0'
  }`,
);
console.log(`   ⇒ ${pass ? '✅ E4 深化成功（可翻生产默认）' : '❌ 未达标，诚实判负留档'}`);

writeFileSync(
  join(ROOT, 'evals', 'layered-fusion-ab.report.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: 'E4 软融合（fusion-not-replace）对照 layered-recall-ab.mjs 的 −9.1pp 负结果留档',
      corpus: { symbols: corpus.symbols.length, files: corpus.files.length },
      queryCount: rows.length,
      staleQueries: stale.map((s) => ({ q: s.q, anchor: s.anchor })),
      fileK: FILE_K,
      iters: ITERS,
      damping: DAMPING,
      recall: {
        bm25: bm25Avg,
        fusion: fusionAvg,
        deltaPp: delta,
      },
      bootstrap: { ...boot, ciCrossesZero, rounds: 2000 },
      tally,
      overlapWithBm25: overlapAvg,
      queryInsensitivity: vetoReport.metrics.queryInsensitivity,
      verdict: {
        thresholdPp: THRESHOLD_PP,
        ciMustNotCrossZero: true,
        pass,
        note: pass
          ? '软融合成功抬升召回且增益可置信，可翻生产默认'
          : '未达 +5pp 或不跨 0，保持 opt-in',
      },
      perQuery: rows.map((r) => ({
        q: r.q,
        anchor: r.anchor,
        gtSize: r.gtSize,
        bm25: r.bm25,
        fusion: r.fusion,
      })),
    },
    null,
    2,
  ),
  'utf8',
);
console.log('\n报告已写入 evals/layered-fusion-ab.report.json');
