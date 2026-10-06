#!/usr/bin/env node
/**
 * BM25 参数扫描探针（离线、确定性；2026-10-05 首次实测——`bm25K1`/`bm25B` 查询期覆盖
 * 管线自 C7 拆分起就绪，但从未真正扫过：默认 k1=1.5 / b=0.75 是教科书值，不是实测值）。
 *
 * ## 回答什么问题
 *
 * 生产默认打分参数是否已是本语料上的最优？若存在**过两关**（配对 bootstrap 95% CI 不跨 0
 * 且留出折无负）的更优点，才值得改默认；否则把「默认即最优」钉成结论，结束这条调参线。
 *
 * ## 口径
 *
 * - 指标：hitRate@20（GT 文件是否进 Top-20），192 条全量（含对抗子集）；
 * - 判定：每个 (k1,b) 组合对默认参数的**逐查询命中差**做配对 bootstrap（固定种子）
 *   + repeated 2-fold 折负统计——与本仓「两关」纪律同款；
 * - **改动默认必须**：最优组合过两关 **且** 比默认高出 ≥1.5pp（低于判据宽度的增益不值得动生产）。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/bm25TuneSweep.mjs [--json=out.json]
 * ```
 *
 * ## 诚实边界
 *
 * - 单语料结论：参数最优性只对**当前语料**负责，语料剧变后应重扫（探针可复现）；
 * - hitRate@20 是文件级命中，不测符号级与排序质量；网格外的参数空间未探索（k1>2.1 / b<0.3 不在格内）；
 * - 实测结论（2026-10-05，语料 1010 文件）：24 组合无一过两关，默认保持——本文件把该结论固化。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) => import(pathToFileURL(join(ROOT, 'dist', ...segments)).href);

/**
 * 读命令行 `--name=value`。
 * @param {string} name 参数名（不含 `--`）。
 * @param {string} dflt 缺省值。
 * @returns {string} 值。
 */
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};

let ContextEngine;
let RECALL_QUERIES;
let CORE_COUNT;
try {
  ({ ContextEngine } = await importDist('src', 'context', 'contextEngine.js'));
  ({ RECALL_QUERIES, CORE_COUNT } = await import(
    pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
  ));
} catch (error) {
  console.error('✗ 缺少编译产物。请先运行 `npm run build`。');
  process.exit(2);
}

const FILE_K = 20;
const GRID_K1 = [0.9, 1.2, 1.5, 1.8, 2.1];
const GRID_B = [0.3, 0.45, 0.6, 0.75, 0.9];
const DEFAULTS = { k1: 1.5, b: 0.75 };

const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { morph: true, light: true });
console.log(
  `语料 ${String(corpus.files.length)} 文件 / ${String(corpus.symbols.length)} 符号 ｜ 查询 ${String(RECALL_QUERIES.length)} 条 ｜ fileK=${String(FILE_K)} ｜ 网格 ${String(GRID_K1.length)}×${String(GRID_B.length)}\n`,
);

/** 机械 GT：锚点字面量出现在文件正文。 */
const gtOf = (anchor) => {
  const needle = anchor.toLowerCase();
  const out = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) out.add(rel);
  }
  return out;
};

const CASES = [];
for (const entry of RECALL_QUERIES) {
  const gt = gtOf(entry.anchor);
  if (gt.size === 0) continue;
  CASES.push({ q: entry.q, gt, tier: CASES.length < CORE_COUNT ? 'core' : 'ext' });
}
console.log(`有效查询 ${String(CASES.length)} 条\n`);

/** 用给定 (k1,b) 跑全部查询，返回逐查询命中向量（0/1）。 */
function hitVector(k1, b) {
  return CASES.map(({ q, gt }) => {
    const res = ContextEngine.query(corpus, q, {
      fileK: FILE_K,
      ...(k1 !== DEFAULTS.k1 ? { bm25K1: k1 } : {}),
      ...(b !== DEFAULTS.b ? { bm25B: b } : {}),
    });
    return res.files.some((f) => gt.has(f)) ? 1 : 0;
  });
}

/** 配对 bootstrap 95% CI（固定种子，与 rerankDiscriminatorAb 同款）。 */
function pairedCI(delta, rounds = 4000) {
  let seed = 0x5eed1e;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let r = 0; r < rounds; r += 1) {
    let s = 0;
    for (let i = 0; i < delta.length; i += 1) s += delta[Math.floor(rnd() * delta.length)];
    out.push((s / delta.length) * 100);
  }
  out.sort((a, b2) => a - b2);
  return [+out[Math.floor(0.025 * rounds)].toFixed(2), +out[Math.floor(0.975 * rounds)].toFixed(2)];
}

/** repeated 2-fold：折上为负的次数。 */
function foldsNeg(delta, reps = 20) {
  let seed = 0x9e3779b9;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  let neg = 0;
  const total = reps * 2;
  for (let r = 0; r < reps; r += 1) {
    const ix = delta.map((_, i) => i);
    for (let i = ix.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [ix[i], ix[j]] = [ix[j], ix[i]];
    }
    const half = Math.floor(ix.length / 2);
    const m1 = ix.slice(0, half).reduce((a, b2) => a + delta[b2], 0) / half;
    const m2 = ix.slice(half).reduce((a, b2) => a + delta[b2], 0) / (ix.length - half);
    if (m1 * 100 < -1e-9) neg += 1;
    if (m2 * 100 < -1e-9) neg += 1;
  }
  return { neg, total };
}

const base = hitVector(DEFAULTS.k1, DEFAULTS.b);
const baseRate = (100 * base.reduce((a, b2) => a + b2, 0)) / base.length;
console.log(
  `默认 k1=${String(DEFAULTS.k1)} b=${String(DEFAULTS.b)}：hitRate@20 = ${baseRate.toFixed(1)}%\n`,
);

const results = [];
for (const k1 of GRID_K1) {
  for (const b of GRID_B) {
    if (k1 === DEFAULTS.k1 && b === DEFAULTS.b) continue;
    const v = hitVector(k1, b);
    const rate = (100 * v.reduce((a, b2) => a + b2, 0)) / v.length;
    const delta = v.map((x, i) => x - base[i]);
    const ci = pairedCI(delta);
    const f = foldsNeg(delta);
    const up = delta.filter((x) => x > 0).length;
    const down = delta.filter((x) => x < 0).length;
    const sig = ci[0] > 0 && f.neg === 0;
    const row = {
      k1,
      b,
      hitRate: +rate.toFixed(1),
      deltaCI: ci,
      upDown: [up, down],
      foldsNeg: `${String(f.neg)}/${String(f.total)}`,
      significant: sig,
    };
    results.push(row);
    console.log(
      `  k1=${k1.toFixed(2)} b=${b.toFixed(2)}  hitRate=${rate.toFixed(1)}%  ΔCI ${JSON.stringify(ci)}pp (↑${String(up)}/↓${String(down)})  折负 ${String(f.neg)}/${String(f.total)} ${sig ? '【过两关】' : ''}`,
    );
  }
}

const winners = results.filter((r) => r.significant && r.hitRate - baseRate >= 1.5);
console.log(
  winners.length === 0
    ? `\n判定：网格内无「过两关且 ≥+1.5pp」的组合 ⇒ **默认 k1=1.5 / b=0.75 保持**（教科书值即本语料实测最优，调参线就此关闭）。`
    : `\n判定：存在过两关组合 ${JSON.stringify(winners)}——改默认前需在 core/ext 分层复核并更新检索基线。`,
);

const JSON_OUT = arg('json', '');
if (JSON_OUT !== '') {
  const out = JSON_OUT;
  writeFileSync(
    out,
    `${JSON.stringify({ probe: 'bm25TuneSweep', defaults: DEFAULTS, baseRate: +baseRate.toFixed(1), results, winners }, null, 2)}\n`,
  );
  console.log(`已写出 ${out}`);
}
