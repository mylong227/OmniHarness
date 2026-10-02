#!/usr/bin/env node
// 跨仓库检索 A/B（L3 证据层，2026-09-27）。
//
// ## 为什么需要它
//
// 仓内检索结论（精排第二段 +2.9pp / 判别器不改）全部建立在单一语料（本仓 `src/`，590 文件）之上。
// 「方向是否跨语料复现」此前不可回答。本仪器把 `rerank-ab.mjs` 的同一套协议复制到 **5 个外部真实
// 仓库**（Python，与本仓 TS 异构；清单只存在于 `tests/fixtures/recallQueriesCrossRepo.ts`，5×12=60 条），
// 采集协议与其注释同口径。
//
// ## 口径（沿用本仓「两关」纪律，与 rerank-ab.mjs 同源）
//   [0] 协议校验（fail-closed）：GT 非空、锚点出现文件数 ≤ 3、查询内容词与锚点子词零交集
//       （复用仓内 `adversarialOverlap`）、查询内容词不命中 GT 文件名词干。任一违例 → exit 1。
//   [1] 候选池天花板（诊断）
//   [2] A/B：生产路径 `getRepoMapContext(root, q, { fileK, rerank: false|true })`，fileK=14 为
//       判定基准档（layered-recall-ab 范式），fileK=10 如实登记
//   [3] 稳健性：成对 bootstrap 95% CI + repeated 2-fold 留出折——分仓各算，并把全部增益
//       **跨仓合并**再算一次（合并是 L3 的主判据）
//   [4] 第一关否决器（查询敏感度 + 基线复读判定）与接线活性守卫
//
// ⚠ 前置条件：外部语料 `eval-data/repos/**`（`.gitignore` 不入库）必须就位，否则本仪器在 [0] 段
// fail-closed 退出——这是刻意的（缺语料时的 Δ 全是噪声）。
//
// 用法：node evals/recall-crossrepo.mjs [--filek N]
// 产物：evals/recall-crossrepo.report.json

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { RepoMapContextEngine } = await importDist('context', 'repoMap', 'repoMapContextEngine.js');
const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { RankVetoEvaluator, RankVetoOverlap, DEFAULT_VETO_THRESHOLDS } = await importDist(
  'context',
  'rankVeto',
  'index.js',
);
const { Bootstrap } = await importDist('evolution', 'bootstrap.js');
const { CROSS_REPO_CORPORA } = await import(
  pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueriesCrossRepo.js')).href
);
// 对抗性判据复用仓内 fixture 的单一真相来源（camelCase/分隔符拆分口径与检索侧一致）。
const { adversarialOverlap, contentTokensOf } = await import(
  pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
);

const FK_ARG = process.argv.indexOf('--filek');
const FILE_KS = FK_ARG >= 0 ? [Number(process.argv[FK_ARG + 1])] : [10, 14];
const DECISION_FILE_K = 14;

const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
const pct = (x) => +(x * 100).toFixed(1);

const engine = new RepoMapContextEngine();

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

const robustnessOf = (gains) => {
  const ci = Bootstrap.bootstrapInterval(gains, (rs) => avg(rs), { rounds: 2000, seed: 0x5eed1e });
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
    negativeFolds: negative,
  };
};

const vetoOf = (offLists, onLists) => {
  let sum = 0;
  for (let i = 0; i < onLists.length; i += 1) {
    sum += RankVetoOverlap.jaccardOverlap(offLists[i], onLists[i]);
  }
  const meanOverlap = sum / Math.max(1, onLists.length);
  const report = new RankVetoEvaluator().evaluate({
    baselineProbeLists: offLists,
    candidateProbeLists: onLists,
  });
  const overlapOk = meanOverlap < DEFAULT_VETO_THRESHOLDS.maxOverlapJaccard;
  return {
    verdict: report.verdict === 'proceed' && overlapOk ? 'proceed' : 'veto',
    reasons: report.reasons,
    meanOverlapJaccard: +meanOverlap.toFixed(3),
    overlapThreshold: DEFAULT_VETO_THRESHOLDS.maxOverlapJaccard,
  };
};

// ── [0] 协议校验（fail-closed）───────────────────────────────────────────────
const corpora = [];
const violations = [];
for (const { repo, root, queries } of CROSS_REPO_CORPORA) {
  const abs = join(ROOT, root);
  const corpus = ContextEngine.indexCorpus(abs, { morph: true, light: true });
  const gtOf = (anchor) => {
    const needle = anchor.toLowerCase();
    const out = new Set();
    for (const [rel, text] of corpus.fileText) {
      if (text.toLowerCase().includes(needle)) out.add(rel);
    }
    return out;
  };
  console.log(
    `语料 ${repo}: ${corpus.files.length} 文件 / ${corpus.symbols.length} 符号 ｜ 查询 ${queries.length} 条`,
  );
  const items = [];
  for (const { q, anchor } of queries) {
    const gt = gtOf(anchor);
    if (gt.size === 0) {
      violations.push(`${repo}: 锚点「${anchor}」在语料中不存在（GT=0）`);
      continue;
    }
    if (gt.size > 3) {
      violations.push(`${repo}: 锚点「${anchor}」出现于 ${gt.size} 个文件（协议上限 3）`);
    }
    const overlap = adversarialOverlap({ q, anchor });
    if (overlap.length > 0) {
      violations.push(`${repo}: 查询与锚点「${anchor}」字面重合：${overlap.join(', ')}`);
    }
    // 路径词禁令：GT 文件名的词干（长度 ≥3）不得出现在查询内容词里。
    const qTokens = contentTokensOf(q);
    for (const rel of gt) {
      const stem =
        rel
          .split('/')
          .pop()
          ?.replace(/\.[a-z]+$/i, '') ?? '';
      for (const piece of stem.split(/[^A-Za-z0-9]+/)) {
        if (piece.length >= 3 && qTokens.has(piece.toLowerCase())) {
          violations.push(`${repo}: 查询含 GT 路径词「${piece}」（${rel}）`);
        }
      }
    }
    items.push({ q, anchor, gt });
  }
  if (items.length === 0) {
    violations.push(`${repo}: 全部查询被协议拦截，语料不可用`);
  }
  corpora.push({ repo, root: abs, corpus, items });
}
if (violations.length > 0) {
  console.error(`\n❌ 协议校验失败 ${violations.length} 条：`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
const totalQueries = corpora.reduce((s, c) => s + c.items.length, 0);
console.log(`协议校验通过：${corpora.length} 仓 / ${totalQueries} 条查询\n`);

// ── [1]+[2]+[3]+[4] 分仓跑 ───────────────────────────────────────────────────
const perRepo = [];
const pooledGains = { 10: [], 14: [] };
const pooledRecallOff = { 10: [], 14: [] };
const pooledRecallOn = { 10: [], 14: [] };
const pooledOff = { 10: [], 14: [] };
const pooledOn = { 10: [], 14: [] };

for (const { repo, root, items } of corpora) {
  console.log(`\n=== ${repo}（${items.length} 条）===`);
  const fileKResults = [];
  for (const fileK of FILE_KS) {
    const rows = [];
    const offLists = [];
    const onLists = [];
    const offRecalls = [];
    const onRecalls = [];
    for (const it of items) {
      const offCtx = engine.getRepoMapContext(root, it.q, { fileK, rerank: false }) ?? '';
      const onCtx = engine.getRepoMapContext(root, it.q, { fileK, rerank: true }) ?? '';
      const off = surfacedFiles(offCtx);
      const on = surfacedFiles(onCtx);
      offLists.push([...off]);
      onLists.push([...on]);
      offRecalls.push(recallOf(it.gt, off));
      onRecalls.push(recallOf(it.gt, on));
      rows.push({ q: it.q, gt: it.gt.size, changed: offCtx !== onCtx });
    }
    const gains = items.map((_, i) => (onRecalls[i] - offRecalls[i]) * 100);
    const offRecall = pct(avg(offRecalls));
    const onRecall = pct(avg(onRecalls));
    const up = gains.filter((g) => g > 1e-9).length;
    const down = gains.filter((g) => g < -1e-9).length;
    const changed = rows.filter((r) => r.changed).length;
    const rob = robustnessOf(gains);
    const veto = vetoOf(offLists, onLists);
    pooledGains[fileK].push(...gains);
    pooledRecallOff[fileK].push(...offRecalls);
    pooledRecallOn[fileK].push(...onRecalls);
    pooledOff[fileK].push(...offLists);
    pooledOn[fileK].push(...onLists);
    console.log(
      `  fileK=${fileK}: 召回 ${offRecall}% → ${onRecall}%（${(onRecall - offRecall).toFixed(1)}pp）↑${up}/↓${down}  CI95 [${rob.ciLoPp}, ${rob.ciHiPp}]pp  负折 ${rob.negativeFolds}/${rob.folds}  否决 ${veto.verdict}  接线 ${changed}/${items.length}`,
    );
    fileKResults.push({
      fileK,
      recall: { off: offRecall, on: onRecall, deltaPp: +(onRecall - offRecall).toFixed(1) },
      distribution: { up, down, flat: items.length - up - down },
      robustness: rob,
      veto,
      wiring: { changedQueries: changed, totalQueries: items.length },
      pooled: false,
    });
  }
  perRepo.push({ repo, queries: items.length, fileKResults });
}

// ── 跨仓合并（L3 主判据）─────────────────────────────────────────────────────
console.log(`\n=== 跨仓合并（${corpora.length} 仓 ${totalQueries} 条，主判据）===`);
const pooled = [];
for (const fileK of FILE_KS) {
  const gains = pooledGains[fileK];
  const rob = robustnessOf(gains);
  const veto = vetoOf(pooledOff[fileK], pooledOn[fileK]);
  const offRecall = pct(avg(pooledRecallOff[fileK]));
  const onRecall = pct(avg(pooledRecallOn[fileK]));
  console.log(
    `  fileK=${fileK}: 召回 ${offRecall}% → ${onRecall}%（${(onRecall - offRecall).toFixed(1)}pp）  CI95 [${rob.ciLoPp}, ${rob.ciHiPp}]  负折 ${rob.negativeFolds}/${rob.folds}（min ${rob.foldMinPp}pp）  否决 ${veto.verdict}`,
  );
  pooled.push({
    fileK,
    recall: { off: offRecall, on: onRecall, deltaPp: +(onRecall - offRecall).toFixed(1) },
    robustness: rob,
    veto,
    decisive: fileK === DECISION_FILE_K,
  });
}

const decisive = pooled.find((p) => p.decisive);
const report = {
  eval: 'recall-crossrepo',
  purpose: `L3：把仓内检索结论放到 ${corpora.length} 个外部真实仓库（Python）上复现检验`,
  generatedAt: new Date().toISOString(),
  path: 'production: RepoMapContextEngine.getRepoMapContext',
  querySource: `tests/fixtures/recallQueriesCrossRepo.ts（${totalQueries} 条，协议同 recallQueries.ts）`,
  protocolChecks: 'GT≠0 + 锚点≤3 文件 + 对抗性零交集 + GT 路径词禁令（fail-closed，见脚本 [0] 段）',
  corpora: CROSS_REPO_CORPORA.map(({ repo, root }) => ({ repo, root })),
  perRepo,
  pooled,
  decisionBasis:
    'L3 复现判据：跨仓合并（fileK=14）平均增益的 CI 下界 > 0 且留出折多数为正；分仓方向一致性另行呈现。',
  pooledReplicatesInRepoDirection: decisive ? decisive.robustness.ciLoPp > 0 : false,
};
writeFileSync(
  new URL('./recall-crossrepo.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/recall-crossrepo.report.json');
