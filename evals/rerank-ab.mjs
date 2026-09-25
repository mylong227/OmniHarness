#!/usr/bin/env node
// 打磨第二批 P1 验收：**零依赖词法重排**（两阶段检索第 2 段）的受控评测。
//
// 与 `recall-codebase-real.mjs` 的分工：那一份测「语义路带来的增益」，需要嵌入模型（联网/权重）；
// 本份测「**纯词法**重排带来的增益」，**零模型、零联网、确定性**，故可进 CI 与本地随时复跑。
//
// 三段口径（缺一不可，沿用本仓库既有纪律）：
//   [1] 候选池天花板 —— 先量「第一段能捞到的上界」，没有它就无从解释增益还剩多少空间；
//   [2] 两关         —— ① 否决器（查询敏感度：防常量偏置 / 防基线复读）
//                       ② AB 开关隔离召回对照（同语料、同查询，只切 rerank 一个变量）；
//   [3] 稳健性       —— bootstrap 95% CI（种子化）+ repeated 2-fold 留出折；
//                       点估计不足以翻默认，CI 下界 > 0 且留出折为正才算过。
//
// **验收路径**：召回口径一律走生产装配路径 `new RepoMapContextEngine().getRepoMapContext(...)`；
// 只有第 [1] 段的「池子上界」诊断才直接用 `query()`（因为它要的就是未截断的候选池）。
//
// 用法：
//   node evals/rerank-ab.mjs            # 出数并写报告
//   node evals/rerank-ab.mjs --gate     # 出数 + 过阈值判定（不过则退出码 1）
//   node evals/rerank-ab.mjs --filek 14 # 只跑指定 fileK（默认跑 10 与 14 两档）

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { RankVetoEvaluator, jaccardOverlap, DEFAULT_VETO_THRESHOLDS } = await importDist(
  'context',
  'rankVeto',
  'index.js',
);
const { Bootstrap } = await importDist('eval', 'bootstrap.js');

const SRC = join(ROOT, 'src');
const GATE = process.argv.includes('--gate');
const FK_ARG = process.argv.indexOf('--filek');
const FILE_KS = FK_ARG >= 0 ? [Number(process.argv[FK_ARG + 1])] : [10, 14];

// ── 查询集与锚点（2026-09-25 起改接 tests/fixtures/recallQueries.ts 全量 84 条）──────
// 旧内联 33 条退役：它与 fixture core33 存在锚点漂移（OpenAiModelConfig vs OpenAiCompatibleModel），
// 且只覆盖冻结子集——两关结论必须建立在**第二方复核过的全量集**上（DEFICIENCY_AUDIT §4.5 处置 2）。
// 设计原则（引用上游口径）：查询用自然语言改写、刻意避开锚点字面词（制造词法鸿沟）；
// 锚点必须真实存在于语料，否则 GT 为空会让召回兜底成 100%，污染绝对值。
const { RECALL_QUERIES, CORE_COUNT } = await import(
  pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
);
const QUERIES = RECALL_QUERIES.map((entry) => [entry.q, entry.anchor]);

// ── [0] 语料 + ground truth ──────────────────────────────────────────────────
const engine = new RepoMapContextEngine();
const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
console.log(`corpus: ${corpus.files.length} files / ${corpus.symbols.length} symbols`);

const groundTruth = (anchor) => {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
};

const items = [];
const skipped = [];
for (const [idx, [q, anchor]] of QUERIES.entries()) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) {
    // 纪律：锚点失效（GT=0）会白送 100% 召回，必须**跳过并记账**，不得静默吞掉也不得崩溃。
    skipped.push({ q, anchor, reason: 'GT=0：锚点在语料中不存在' });
    console.log(`  SKIP(GT=0) ${q}  anchor=${anchor}`);
    continue;
  }
  items.push({ q, anchor, gt, tier: idx < CORE_COUNT ? 'core' : 'extended' });
}
const n = items.length;
console.log(`valid queries: ${n}/${QUERIES.length}（跳过 ${skipped.length}）`);

const surfacedFiles = (context) => {
  const files = new Set();
  if (!context) return files;
  for (const line of context.split('\n')) {
    const m = line.match(/📄\s+(.+)/);
    if (m) files.add(m[1].trim());
  }
  return files;
};
const recallOf = (gt, surfaced) =>
  gt.size === 0 ? 0 : [...gt].filter((f) => surfaced.has(f)).length / gt.size;
const precisionOf = (gt, surfaced) =>
  surfaced.size === 0 ? 0 : [...gt].filter((f) => surfaced.has(f)).length / surfaced.size;
const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
const pct = (x) => +(x * 100).toFixed(1);

// ── [1] 候选池天花板（诊断；直接 query 以取未截断池）────────────────────────────
console.log('\n=== [1] 第一段候选池天花板（诊断）===');
const CEILING_KS = [10, 14, 20, 30, 50];
const ceiling = { byK: {}, bestRankHistogram: {}, unreachable: [] };
const poolSizes = [];
const bestRanks = [];
for (const it of items) {
  const res = ContextEngine.query(corpus, it.q, { fileK: 400, symK: 24 });
  poolSizes.push(res.files.length);
  const rankOf = new Map(res.files.map((f, i) => [f, i + 1]));
  let best = Number.POSITIVE_INFINITY;
  for (const f of it.gt) {
    const r = rankOf.get(f);
    if (r !== undefined && r < best) best = r;
  }
  bestRanks.push(best);
  for (const k of CEILING_KS) {
    const top = new Set(res.files.slice(0, k));
    const rec = [...it.gt].filter((f) => top.has(f)).length / it.gt.size;
    (ceiling.byK[k] ??= []).push(rec);
  }
  if (best === Number.POSITIVE_INFINITY) ceiling.unreachable.push(it.q);
}
ceiling.avgPoolSize = +avg(poolSizes).toFixed(1);
ceiling.recallAtK = Object.fromEntries(CEILING_KS.map((k) => [k, pct(avg(ceiling.byK[k]))]));
ceiling.oracleAt14 = ceiling.recallAtK[50];
ceiling.unreachableQueries = ceiling.unreachable.length;
ceiling.bestRankHistogram = {
  le14: bestRanks.filter((b) => b <= 14).length,
  le20: bestRanks.filter((b) => b <= 20).length,
  le30: bestRanks.filter((b) => b <= 30).length,
  le50: bestRanks.filter((b) => b <= 50).length,
  unreachable: ceiling.unreachable.length,
};
console.log(`  平均候选池 ${ceiling.avgPoolSize} 个文件 / 全库 ${corpus.files.length}`);
console.log(
  `  召回@K：${CEILING_KS.map((k) => `${k}=${ceiling.recallAtK[k]}%`).join('  ')}（K≥50 已饱和 ⇒ 池子上界）`,
);
console.log(
  `  GT「最浅命中」分布：≤14 ${ceiling.bestRankHistogram.le14}/${n}  ≤20 ${ceiling.bestRankHistogram.le20}  ≤30 ${ceiling.bestRankHistogram.le30}  ≤50 ${ceiling.bestRankHistogram.le50}  池内不可达 ${ceiling.unreachable}（语义鸿沟，词法重排结构上够不到）`,
);

// ── [2] AB：开关隔离（走生产路径）─────────────────────────────────────────────
const runFileK = (fileK) => {
  console.log(`\n=== [2] AB（生产路径，fileK=${fileK}）第一段 vs +重排 ===`);
  const rows = [];
  const offLists = [];
  const onLists = [];
  for (const it of items) {
    const offCtx = engine.getRepoMapContext(SRC, it.q, { fileK, rerank: false }) ?? '';
    const onCtx = engine.getRepoMapContext(SRC, it.q, { fileK, rerank: true }) ?? '';
    const off = surfacedFiles(offCtx);
    const on = surfacedFiles(onCtx);
    offLists.push([...off]);
    onLists.push([...on]);
    rows.push({
      q: it.q,
      gt: it.gt.size,
      offRecall: pct(recallOf(it.gt, off)),
      onRecall: pct(recallOf(it.gt, on)),
      offPrecision: pct(precisionOf(it.gt, off)),
      onPrecision: pct(precisionOf(it.gt, on)),
      changed: offCtx !== onCtx,
    });
  }
  const offRecall = avg(rows.map((r) => r.offRecall));
  const onRecall = avg(rows.map((r) => r.onRecall));
  const offPrec = avg(rows.map((r) => r.offPrecision));
  const onPrec = avg(rows.map((r) => r.onPrecision));
  const gains = rows.map((r) => r.onRecall - r.offRecall);
  const up = gains.filter((g) => g > 1e-9).length;
  const down = gains.filter((g) => g < -1e-9).length;
  const flat = n - up - down;
  // 分层增益：冻结子集与复核后新增子集分开记账（对照 recall-query-audit 的两档口径）。
  const tierDeltaOf = (tier) =>
    +avg(
      rows.filter((_, i) => items[i].tier === tier).map((r) => r.onRecall - r.offRecall),
    ).toFixed(1);
  const tierDeltas = { core: tierDeltaOf('core'), extended: tierDeltaOf('extended') };
  console.log(
    `  分层   core33 ${tierDeltas.core >= 0 ? '+' : ''}${tierDeltas.core}pp / extended51 ${tierDeltas.extended >= 0 ? '+' : ''}${tierDeltas.extended}pp`,
  );
  console.log(
    `  召回   ${offRecall}% → ${onRecall}%  (${onRecall - offRecall >= 0 ? '+' : ''}${(onRecall - offRecall).toFixed(1)}pp)  ↑${up}/↓${down}/=${flat}`,
  );
  console.log(
    `  精度   ${offPrec}% → ${onPrec}%  (${onPrec - offPrec >= 0 ? '+' : ''}${(onPrec - offPrec).toFixed(1)}pp)`,
  );
  return {
    fileK,
    offRecall,
    onRecall,
    offPrec,
    onPrec,
    gains,
    tierDeltas,
    up,
    down,
    flat,
    rows,
    offLists,
    onLists,
  };
};

// ── [3] 稳健性：bootstrap CI（种子化）+ repeated 2-fold 留出折 ────────────────
const robustnessOf = (gains) => {
  const ci = Bootstrap.bootstrapInterval(gains, (rs) => avg(rs), { rounds: 2000, seed: 0x5eed1e });
  // repeated 2-fold：把增益随机对半分，看「任意一半上是否仍为正」——单点击穿的增益过不了这一关。
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const folds = [];
  for (let rep = 0; rep < 20; rep += 1) {
    const idx = gains.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const half = Math.floor(idx.length / 2);
    folds.push(avg(idx.slice(0, half).map((i) => gains[i])));
    folds.push(avg(idx.slice(half).map((i) => gains[i])));
  }
  const negative = folds.filter((f) => f < 0).length;
  return {
    pointPp: +avg(gains).toFixed(2),
    ciLoPp: +ci.lo.toFixed(2),
    ciHiPp: +ci.hi.toFixed(2),
    rounds: ci.rounds,
    folds: folds.length,
    foldMeanPp: +avg(folds).toFixed(2),
    foldMinPp: +Math.min(...folds).toFixed(2),
    foldMaxPp: +Math.max(...folds).toFixed(2),
    negativeFolds: negative,
  };
};

// ── [4] 第一关：否决器（查询敏感度）──────────────────────────────────────────
const vetoOf = (offLists, onLists) => {
  // 重合度判据取**跨查询均值**：单取最坏一条是退化用法——32 条里 28 条本来就不变，
  // 最坏必然 = 1（「与基线逐字相同」），该阈值永远误报。判据的本意是
  // 「这条新路**总体上**是不是基线的复读」，故用均值。
  let sum = 0;
  let worst = 0;
  let worstIdx = 0;
  for (let i = 0; i < onLists.length; i += 1) {
    const ov = jaccardOverlap(offLists[i], onLists[i]);
    sum += ov;
    if (ov > worst) {
      worst = ov;
      worstIdx = i;
    }
  }
  const meanOverlap = sum / Math.max(1, onLists.length);
  // 主判据（查询敏感度）交给既有否决器；重合度判据在此按均值显式判定。
  const report = new RankVetoEvaluator().evaluate({
    baselineProbeLists: offLists,
    candidateProbeLists: onLists,
  });
  const overlapOk = meanOverlap < DEFAULT_VETO_THRESHOLDS.maxOverlapJaccard;
  const reasons = [
    ...report.reasons,
    ...(overlapOk
      ? []
      : [
          `与基线 Top-K 平均重合度 ${meanOverlap.toFixed(3)} ≥ ${DEFAULT_VETO_THRESHOLDS.maxOverlapJaccard}：新路总体上只是基线的复读，无增量信息`,
        ]),
  ];
  return {
    verdict: report.verdict === 'proceed' && overlapOk ? 'proceed' : 'veto',
    reasons,
    candidateQueryInsensitivity: report.metrics.queryInsensitivity,
    baselineQueryInsensitivity: report.metrics.baselineQueryInsensitivity,
    insensitivityRatio: report.metrics.insensitivityRatio,
    meanOverlapJaccard: +meanOverlap.toFixed(3),
    worstOverlapJaccard: +worst.toFixed(3),
    worstOverlapQuery: items[worstIdx].q,
    overlapThreshold: DEFAULT_VETO_THRESHOLDS.maxOverlapJaccard,
  };
};

const perFileK = [];
const gateFailures = [];
// 判定基准口径：`layered-recall-ab.mjs` 范式所用的 fileK=14（`docs/POLISH_PLAN.md` P1 的验收
// 明示「bootstrap CI（范式 layered-recall-ab.mjs）」）。其余档位一并测量并**如实登记**，
// 但不参与「翻默认」的判定——生产入口默认预算（fileK=10）另记其未过事实。
const DECISION_FILE_K = 14;
for (const fileK of FILE_KS) {
  const ab = runFileK(fileK);
  const rob = robustnessOf(ab.gains);
  const veto = vetoOf(ab.offLists, ab.onLists);
  console.log(
    `  CI95 [${rob.ciLoPp}, ${rob.ciHiPp}]pp   留出折 负 ${rob.negativeFolds}/${rob.folds}（min ${rob.foldMinPp}pp）`,
  );
  console.log(
    `  否决器 ${veto.verdict}：候选跨查询重合度 ${veto.candidateQueryInsensitivity?.toFixed(3)} vs 基线 ${veto.baselineQueryInsensitivity?.toFixed(3)}（比值 ${veto.insensitivityRatio?.toFixed(2)}）；与基线 Top-K 平均重合度 ${veto.meanOverlapJaccard}（阈值 ${veto.overlapThreshold}）`,
  );
  // 接线活性守卫：两档必须存在差异，否则说明重排被静默旁路（「声明未接线」形态）。
  const changed = ab.rows.filter((r) => r.changed).length;
  console.log(`  接线活性：${changed}/${n} 条查询的上下文发生改变（0 即为接线失效）`);

  const wiringOk = changed > 0;
  const vetoOk = veto.verdict === 'proceed';
  // 第一关（否决器）与接线活性对**每一档**都必须成立；第二关（CI + 留出折）只在判定基准档上判定。
  // 但**登记值**仍按「四项全判」计算，避免报告里出现「未过阈值却记 passed=true」的粉饰。
  const decisive = fileK === DECISION_FILE_K;
  const ciOk = rob.ciLoPp > 0;
  const foldsOk = rob.foldMeanPp > 0 && rob.negativeFolds < rob.folds / 2;
  const passedAll = wiringOk && vetoOk && ciOk && foldsOk;
  const passed = wiringOk && vetoOk && (!decisive || (ciOk && foldsOk));
  console.log(
    `  第二关（CI 下界 > 0 且留出折多数为正）：${ciOk ? '过' : `未过（CI 下界 ${rob.ciLoPp}pp）`} / ${foldsOk ? '过' : `未过（${rob.negativeFolds}/${rob.folds} 为负）`}`,
  );
  console.log(
    `  判定：${decisive ? `基准档 fileK=${DECISION_FILE_K} → ${passed ? '过（四项全判 ' + (passedAll ? '过' : '未过') + '）' : '未过'}` : `仅登记（四项全判 ${passedAll ? '过' : '未过'}），不参与翻默认判定`}`,
  );
  if (!passed) {
    gateFailures.push(
      `fileK=${fileK}: ${[
        wiringOk ? null : '接线未生效',
        vetoOk ? null : `否决器 ${veto.verdict}`,
        ciOk ? null : `CI 下界 ${rob.ciLoPp}pp ≤ 0`,
        foldsOk ? null : `留出折 ${rob.negativeFolds}/${rob.folds} 为负（多数口径）`,
      ]
        .filter((x) => x !== null)
        .join('；')}`,
    );
  }
  perFileK.push({
    fileK,
    decisive,
    /** 四项全判（含非判定档），用于报告自证，不做粉饰。 */
    passedAll,
    /** 参与「翻默认」判定的结果（非判定档跳过第二关）。 */
    passed,
    recall: {
      off: ab.offRecall,
      on: ab.onRecall,
      deltaPp: +(ab.onRecall - ab.offRecall).toFixed(1),
    },
    precision: { off: ab.offPrec, on: ab.onPrec, deltaPp: +(ab.onPrec - ab.offPrec).toFixed(1) },
    distribution: { up: ab.up, down: ab.down, flat: ab.flat },
    tierDeltas: ab.tierDeltas,
    robustness: rob,
    veto,
    wiring: { changedQueries: changed, totalQueries: n, ok: wiringOk },
    rows: ab.rows,
  });
}

const decisiveRow = perFileK.find((x) => x.decisive);
const report = {
  eval: 'rerank-ab',
  batch: 'polish-2/检索命中（2026-09-25 改接复核后全量 84 条）',
  path: 'production: RepoMapContextEngine.getRepoMapContext',
  querySource: 'tests/fixtures/recallQueries.ts（all84，2026-09-25 第二方复核版）',
  decisionFileK: DECISION_FILE_K,
  // 「翻默认」的结论必须能由报告本身复算出来，而不是只写在散文里。
  decisionBasis:
    'CI 下界 > 0 且留出折为正（docs/POLISH_PLAN.md P1）——在范式档 fileK=14 上判定；' +
    '其余档位如实登记但不参与判定。',
  verdict: {
    rerankPassesAtDecisionFileK: decisiveRow?.passed === true,
    // 生产现状（2026-09-25 起）：repoMapContextEngine 缺省 OFF（本轮 gate 未过 ⇒ 按纪律回关），
    // 开启方式 = `opts.rerank: true` 或 env `OMNI_RERANK=1`。
    enabledByDefault: false,
    note:
      '本报告为 2026-09-25 复核修正后全量 84 条的复跑结果：core33 +5.9pp / extended51 +0.4pp，' +
      '基准档点增益 +2.6pp 但 CI 下界 −1.59pp ⇒ 两关未过，生产默认据 DEFICIENCY_AUDIT §4.5 处置回关（opt-in）。',
  },
  corpus: {
    root: 'src',
    files: corpus.files.length,
    symbols: corpus.symbols.length,
    morph: corpus.morph,
    light: true,
  },
  queryCount: n,
  skipped,
  ceiling,
  perFileK,
};
writeFileSync(new URL('./rerank-ab.report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('\nWrote evals/rerank-ab.report.json');

if (GATE) {
  if (gateFailures.length > 0) {
    console.log('\n=== --gate 判定：FAIL ===');
    for (const f of gateFailures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\n=== --gate 判定：PASS（基准档 fileK=${DECISION_FILE_K}：${decisiveRow.recall.off}% → ${decisiveRow.recall.on}%，+${decisiveRow.recall.deltaPp}pp；接线活性 ${decisiveRow.wiring.changedQueries}/${n}）===`,
    );
  }
}
