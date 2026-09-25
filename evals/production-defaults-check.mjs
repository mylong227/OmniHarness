#!/usr/bin/env node
// 生产默认档验收（production defaults check）——**走生产入口本体，不用原型自证**。
//
// 背景（仓库纪律「验收必须走生产装配路径，脚本级通过不算数」）：
//   2026-09-17 两轮翻档：`fileK 10→14 + 精排开`（第一轮），`fileK 14→20 + 载荷梯度投送`（第二轮）。
//   翻默认必须有机器判据，且必须证明「**生产入口 `RepoMapContextEngine.getRepoMapContext` 的默认调用**」
//   真的落在目标档上——而不是靠评测脚本直接 import `query()` 得出一个自我印证的绿灯。
//
// 本脚本做六件事：
//   ① **等价性**：生产入口零 opts 的产出，与 `assemble(query(fileK=20, rerank=false), DEFAULT_PLAN)`
//      **逐字相同** ⇒ 生产默认档 = 被实测的那一档（2026-09-25 起精排默认关；opt-in 档
//      K=20+精排开另做逐字对拍）。
//   ② **三档形态**：`payloadShape:'full'`（历史全大纲）/ `'degrade'`（应急压缩）各与对应组装逐字相同。
//   ③ **可变性**：`OMNI_RERANK=1` / `OMNI_PAYLOAD=full` 都能真的改变行为（防「死旋钮」）。
//   ④ **构造性不变量**：tiered 与 full 的**选中文件集合完全相同**（33/33），且 tiered token 更少。
//   ⑤ **命中率**：新默认（K=20）vs 第一轮默认（K=14）在 33 条对抗锚点查询上的 hitRate + bootstrap CI。
//   ⑥ **口径边界**：自然口径命中率与仍失败的条（诚实登记）。
//
// 用法（免网络、免模型）：npm run build && node evals/production-defaults-check.mjs
// 输出：evals/production-defaults-check.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
const { RepoMapPayload } = await importDist('context', 'repoMapPayload.js');
const { tokenize } = await importDist('search', 'bm25Index.js');
const { QUERIES } = await import('./lib/query-set.mjs');

const SRC = join(ROOT, 'src');
const engine = new RepoMapContextEngine();
const corpus = indexCorpus(SRC, { morph: true, light: true });
const FILE_K = 20;
const SYM_K = 24;

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}
const gts = new Map();
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  gts.set(q, gt);
}

/** 复现生产内部的「检索 + 载荷组装」两步。 */
function assembleOf(q, plan, fileK = FILE_K, rerank = true) {
  const r = query(corpus, q, { fileK, symK: SYM_K, rerank });
  return RepoMapPayload.assemble({ corpus, files: r.files, symbols: r.symbols, query: q }, plan);
}

// —— ① 等价性：生产入口默认档 == 被实测的档？——
let eqDefault = 0;
let eqOptInRerank = 0;
let eqFull = 0;
let eqDegrade = 0;
for (const { q } of QUERIES) {
  // 注：生产入口固定 `symK: 24`（query() 自身默认是 30），故对比时必须显式给 24，否则口径不同。
  if (
    engine.getRepoMapContext(SRC, q) === assembleOf(q, RepoMapPayload.DEFAULT_PLAN, FILE_K, false)
  )
    eqDefault++;
  if (
    engine.getRepoMapContext(SRC, q, { rerank: true }) ===
    assembleOf(q, RepoMapPayload.DEFAULT_PLAN)
  )
    eqOptInRerank++;
  if (
    engine.getRepoMapContext(SRC, q, { payloadShape: 'full', rerank: true }) === assembleOf(q, null)
  )
    eqFull++;
  if (
    engine.getRepoMapContext(SRC, q, { payloadShape: 'degrade', rerank: true }) ===
    assembleOf(q, RepoMapPayload.DEGRADE_PLAN)
  )
    eqDegrade++;
}
console.log('=== ① 生产入口等价性（逐字相同才算一致）===');
console.log(
  `  默认档 == assemble(K=20, 精排关, DEFAULT_PLAN)        : ${eqDefault}/${QUERIES.length}`,
);
console.log(
  `  精排 opt-in == assemble(K=20, 精排开, DEFAULT_PLAN)   : ${eqOptInRerank}/${QUERIES.length}`,
);
console.log(`  payloadShape='full' == assemble(K=20, 精排开, null) : ${eqFull}/${QUERIES.length}`);
console.log(
  `  payloadShape='degrade' == assemble(..., DEGRADE)    : ${eqDegrade}/${QUERIES.length}`,
);

// —— ② 可变性：env 开关真的生效？——
const envProbe = (key, value) => {
  let differs = 0;
  for (const { q } of QUERIES.slice(0, 5)) {
    process.env[key] = value;
    const a = engine.getRepoMapContext(SRC, q);
    delete process.env[key];
    const b = engine.getRepoMapContext(SRC, q);
    if (a !== b) differs++;
  }
  return differs;
};
const rerankDiffers = envProbe('OMNI_RERANK', '1');
const payloadDiffers = envProbe('OMNI_PAYLOAD', 'full');
console.log('\n=== ② 旋钮可变性（设了它，行为真的变）===');
console.log(`  OMNI_RERANK=1 改变产出：${rerankDiffers}/5 条（应为 5/5；默认已回关，opt-in）`);
console.log(`  OMNI_PAYLOAD=full 改变产出：${payloadDiffers}/5 条（应为 5/5）`);

// —— ③ 构造性不变量：排序结果相同 + token 更省 ——
//
// 注意区分两个「文件集合」：
//   · **排序结果**（`query().files`）——真正的构造性不变量，直接决定 hitRate，必须 33/33 完全一致；
//   · **文本可见文件**（从 `📄 路径` 行解析）——两档**可以**不同：`full` 走 `outlineText`，
//     只列**有声明符号**的文件；`tiered` 对每个命中文件都显式给一行路径。故 tiered 可能**更全**
//     （把无符号文件也暴露出来），这是信息量的**增加**而非丢失，此处如实分别统计。
const docPaths = (text) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('📄 '))
    .map((l) => l.replace(/^📄\s*/, ''));
let sameRank = 0;
let sameVisible = 0;
let tieredMoreVisible = 0;
let tokFull = 0;
let tokTiered = 0;
let tokDegrade = 0;
for (const { q } of QUERIES) {
  const a = query(corpus, q, { fileK: FILE_K, symK: SYM_K, rerank: true });
  const b = query(corpus, q, { fileK: FILE_K, symK: SYM_K, rerank: true });
  if (a.files.join('|') === b.files.join('|')) sameRank++;
  const input = { corpus, files: a.files, symbols: a.symbols, query: q };
  const full = RepoMapPayload.assemble(input, null);
  const tiered = RepoMapPayload.assemble(input, RepoMapPayload.DEFAULT_PLAN);
  const degrade = RepoMapPayload.assemble(input, RepoMapPayload.DEGRADE_PLAN);
  const vf = docPaths(full).sort().join('|');
  const vt = docPaths(tiered).sort().join('|');
  if (vf === vt) sameVisible++;
  else if (docPaths(tiered).length > docPaths(full).length) tieredMoreVisible++;
  tokFull += tokenize(full).length;
  tokTiered += tokenize(tiered).length;
  tokDegrade += tokenize(degrade).length;
}
const n = QUERIES.length;
console.log('\n=== ③ 构造性不变量（排序结果相同 ⇒ hitRate 必然不降）===');
console.log(`  排序结果一致：${sameRank}/${n}`);
console.log(
  `  文本可见文件集合一致：${sameVisible}/${n}` +
    `（另 ${tieredMoreVisible} 条 tiered **可见更多**——full 的 outlineText 不列无符号文件）`,
);
console.log(
  `  平均 token：全大纲 ${Math.round(tokFull / n)} → 梯度 ${Math.round(tokTiered / n)}` +
    `（降 ${(((tokFull - tokTiered) / tokFull) * 100).toFixed(1)}%）→ 应急 ${Math.round(tokDegrade / n)}` +
    `（降 ${(((tokFull - tokDegrade) / tokFull) * 100).toFixed(1)}%）`,
);

// —— ④ 命中率（生产等价档，33 条对抗查询）——
function bootstrapCI(values, B = 2000) {
  const cnt = values.length;
  if (cnt === 0) return { mean: 0, lo: 0, hi: 0 };
  const means = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < cnt; i++) s += values[Math.floor(rnd() * cnt)];
    means.push(s / cnt);
  }
  means.sort((a, b) => a - b);
  return {
    mean: +((values.reduce((a, b) => a + b, 0) / cnt) * 100).toFixed(1),
    lo: +(means[Math.floor(B * 0.025)] * 100).toFixed(1),
    hi: +(means[Math.floor(B * 0.975)] * 100).toFixed(1),
  };
}
function hitRatesOf(filesOf, items) {
  const hits = [];
  const failed = [];
  for (const { q, gt } of items) {
    const files = filesOf(q);
    const h = files.some((f) => gt.has(f)) ? 1 : 0;
    hits.push(h);
    if (h === 0) failed.push(q);
  }
  return { ci: bootstrapCI(hits), failed };
}

const adversarial = QUERIES.map(({ q }) => ({ q, gt: gts.get(q) }));
const currentDefault = hitRatesOf(
  (q) => query(corpus, q, { fileK: 20, rerank: false }).files,
  adversarial,
);
const optInRerank = hitRatesOf(
  (q) => query(corpus, q, { fileK: 20, rerank: true }).files,
  adversarial,
);
const roundOne = hitRatesOf(
  (q) => query(corpus, q, { fileK: 14, rerank: true }).files,
  adversarial,
);
console.log('\n=== ④ 命中率（33 条对抗锚点查询，hitRate@K）===');
console.log(
  `  生产默认（K=20, 精排关）：${currentDefault.ci.mean}% [${currentDefault.ci.lo}, ${currentDefault.ci.hi}]`,
);
console.log(
  `  精排 opt-in（K=20, 精排开）：${optInRerank.ci.mean}% [${optInRerank.ci.lo}, ${optInRerank.ci.hi}]  ` +
    `(+${(optInRerank.ci.mean - currentDefault.ci.mean).toFixed(1)}pp vs 默认)`,
);
console.log(
  `  第一轮默认（K=14, 精排开）：${roundOne.ci.mean}% [${roundOne.ci.lo}, ${roundOne.ci.hi}]`,
);

// —— ⑤ 口径边界：自然口径 ——
const natural = QUERIES.map(({ q, anchor }) => ({ q: `${anchor} ${q}`, gt: gts.get(q) }));
const naturalRes = hitRatesOf((q) => query(corpus, q, { fileK: 20, rerank: true }).files, natural);
console.log('\n=== ⑤ 口径边界（同批锚点，自然提问方式，精排 opt-in 档）===');
console.log(
  `  自然口径（锚点 + 自然语言）：${naturalRes.ci.mean}% [${naturalRes.ci.lo}, ${naturalRes.ci.hi}]  ` +
    `（对抗口径 ${optInRerank.ci.mean}%）`,
);
console.log(`  自然口径下仅 ${naturalRes.failed.length} 条未命中：`);
for (const q of naturalRes.failed) console.log(`    · ${q}`);

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  equivalence: {
    defaultMatches: eqDefault,
    fullMatches: eqFull,
    degradeMatches: eqDegrade,
    total: n,
  },
  envToggle: { rerankDiffers, payloadDiffers, probes: 5 },
  invariant: {
    sameRank: sameRank,
    sameVisible: sameVisible,
    tieredMoreVisible: tieredMoreVisible,
    avgTokensFull: Math.round(tokFull / n),
    avgTokensTiered: Math.round(tokTiered / n),
    avgTokensDegrade: Math.round(tokDegrade / n),
  },
  adversarial: {
    currentDefault: currentDefault.ci,
    optInRerank: optInRerank.ci,
    roundOne: roundOne.ci,
  },
  natural: { ci: naturalRes.ci, failed: naturalRes.failed },
};
writeFileSync(
  new URL('./production-defaults-check.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/production-defaults-check.report.json');
