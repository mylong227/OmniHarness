#!/usr/bin/env node
/**
 * 精排**判别器**受控对照探针（G21 提升入库，2026-10-03；**离线、免网络、免模型、确定性**）。
 *
 * ## 回答什么问题
 *
 * `fileReranker.ts` 的模块头登记了「兄弟文件抬升」这一失败形态，并证伪了最直觉的修法（稀有词门）。
 * 要判断**换判别器**是否真有增益，必须做到三件事（本探针就是这三件事的实现）：
 *   ① 同一候选池、同一公式骨架，**只换判别器一项**（受控）；
 *   ② **成对 bootstrap 95% CI + repeated 2-fold 留出折**（本仓「两关」纪律：CI 跨 0 或折不同向即不算增益）；
 *   ③ 有区分 1–3pp 的判定力（查询集越大越好，故支持任意 fixture 全量）。
 *
 * ## 变体（均为「倒数秩 rr + 覆盖率」骨架，覆盖率口径不同）
 *
 * - `V_off` 完全不重排（第一段次序）——回答「第二段净效果」的参照系；
 * - `V0` 现生产式：覆盖率分子按**文件声明符号名**是否含该词计；
 * - `V1` 纯覆盖率（去名次项）；`V11` 词项独占；`V12` 认领摊分；`V13` 软独占；
 * - `V6` 确定性 MMR（贪婪，得分 = 基础分 − λ·与已选文件的最大符号名 Jaccard）。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/rerankDiscriminatorAb.mjs [K] [--pool N] [--json=out.json]
 * ```
 *
 * ## 诚实边界
 *
 * 变体在**探针内**实现（不改生产代码）⇒ 它衡量的是"若换成该判别器会怎样"，不是"生产已如此"。
 * 判定任何变体胜出前必须同时过两关（CI 不跨 0 **且** 留出折同向），单看均值即宣称增益是本仓明令禁止的。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

/**
 * 读命令行 `--name=value`。
 * @param {string} name 参数名（不含 `--`）。
 * @param {string} dflt 缺省值。
 * @returns {string} 值。
 */
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}

let ContextEngine;
let FileRerankIndex;
let RECALL_QUERIES;
let CORE_COUNT;
try {
  ({ ContextEngine } = await importDist('context', 'contextEngine.js'));
  ({ FileRerankIndex } = await importDist('context', 'fileRerankIndex.js'));
  ({ RECALL_QUERIES, CORE_COUNT } = await import(
    pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
  ));
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const K = Number(process.argv[2] ?? 20);
const POOL = Number(arg('pool', '400'));
const ONLY = arg('only', '');
const JSON_OUT = arg('json', '');

const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { morph: true, light: true });
const idx = new FileRerankIndex();
console.log(
  `语料 ${String(corpus.files.length)} 文件 / ${String(corpus.symbols.length)} 符号 ｜ 查询 ${String(RECALL_QUERIES.length)} 条 ｜ K=${String(K)} ｜ pool=${String(POOL)}\n`,
);

/** 机械 GT：文件正文含锚点字面量。 */
const gtOf = (anchor) => {
  const needle = anchor.toLowerCase();
  const out = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) out.add(rel);
  }
  return out;
};

const CASES = [];
for (const [i, entry] of RECALL_QUERIES.entries()) {
  const gt = gtOf(entry.anchor);
  if (gt.size === 0) continue;
  const res = ContextEngine.query(corpus, entry.q, { fileK: POOL, symK: 24 });
  CASES.push({
    q: entry.q,
    anchor: entry.anchor,
    gt,
    cands: res.files,
    tier: i < CORE_COUNT ? 'core' : 'ext',
  });
}
console.log(`有效查询 ${String(CASES.length)}/${String(RECALL_QUERIES.length)}\n`);

const namesOf = new Map();
const names = (rel) => {
  let s = namesOf.get(rel);
  if (s === undefined) {
    s = idx.nameTerms(corpus, rel);
    namesOf.set(rel, s);
  }
  return s;
};

/**
 * 覆盖率共用部分：每个词项的权重与「哪些候选声明了它」。
 * @param {string} q 查询。
 * @param {readonly string[]} cands 候选文件。
 * @returns {{terms: readonly string[], weights: readonly number[], total: number, claimants: readonly Set<string>[]}} 中间量。
 */
function termsOf(q, cands) {
  const terms = idx.contentTerms(corpus, q);
  const weights = terms.map((t) => idx.weight(corpus, t));
  const total = weights.reduce((a, b) => a + b, 0);
  const claimants = terms.map((t) => {
    const set = new Set();
    cands.forEach((rel, i) => {
      if (names(rel).has(t)) set.add(`${String(i)}\u0000${rel}`);
    });
    return set;
  });
  return { terms, weights, total, claimants };
}

/**
 * 覆盖率打分（四种口径）。
 * @param {number} i 候选名次。
 * @param {string} rel 候选文件。
 * @param {readonly number[]} weights 词项权重。
 * @param {readonly Set<string>[]} claimants 每词项的认领集合。
 * @param {'plain'|'split'|'exclusive'|'soft'} mode 口径。
 * @returns {number} 覆盖率得分。
 */
function covOf(i, rel, weights, claimants, mode) {
  let got = 0;
  for (let k = 0; k < weights.length; k += 1) {
    const claim = claimants[k];
    if (!claim.has(`${String(i)}\u0000${rel}`)) continue;
    if (mode === 'split') got += weights[k] / claim.size;
    else if (mode === 'exclusive' || mode === 'soft') {
      const winner = [...claim].sort((a, b) => {
        const [ai, ar] = a.split('\u0000');
        const [bi, br] = b.split('\u0000');
        return Number(ai) - Number(bi) || (ar < br ? -1 : 1);
      })[0];
      const mine = `${String(i)}\u0000${rel}`;
      if (winner === mine) got += weights[k];
      else if (mode === 'soft') got += weights[k] / claim.size;
    } else got += weights[k];
  }
  return got;
}

const order = (scoreFn) =>
  CASES.map(({ q, cands }) => {
    const { weights, total, claimants } = termsOf(q, cands);
    const scored = cands.map((rel, i) => ({
      rel,
      i,
      s: scoreFn(rel, i, weights, claimants, total),
    }));
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    return scored.slice(0, K).map((x) => x.rel);
  });

const VARIANTS = {
  'V_off 第一段（不重排）': (_rel, i) => -i,
  'V0 现生产式（rr+覆盖）': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'plain') / total,
  'V1 纯覆盖（无名次项）': (rel, i, w, c, total) => covOf(i, rel, w, c, 'plain') / total,
  'V11 词项独占 + rr': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'exclusive') / total,
  'V12 认领摊分 + rr': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'split') / total,
  'V13 软独占 + rr': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'soft') / total,
};

/**
 * V6 确定性 MMR：贪婪，每次取「基础分 − λ·与已选最大 Jaccard」。
 * @param {number} lambda 多样性权重。
 * @returns {string[][]} 每条查询的排序结果。
 */
function mmrOrder(lambda) {
  return CASES.map(({ q, cands }) => {
    const { weights, total, claimants } = termsOf(q, cands);
    const base = cands.map(
      (rel, i) => 1 / (1 + (i + 1)) + covOf(i, rel, weights, claimants, 'plain') / total,
    );
    const sets = cands.map((rel) => names(rel));
    const chosen = [];
    const used = new Set();
    while (chosen.length < Math.min(K, cands.length)) {
      let bestIdx = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < cands.length; i += 1) {
        if (used.has(i)) continue;
        let maxSim = 0;
        for (const j of chosen) {
          let inter = 0;
          for (const t of sets[i]) if (sets[j].has(t)) inter += 1;
          const union = sets[i].size + sets[j].size - inter;
          const sim = union === 0 ? 0 : inter / union;
          if (sim > maxSim) maxSim = sim;
        }
        const s = base[i] - lambda * maxSim;
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      used.add(bestIdx);
      chosen.push(bestIdx);
    }
    return chosen.map((i) => cands[i]);
  });
}

const hitVec = (lists) => lists.map((files, i) => (files.some((f) => CASES[i].gt.has(f)) ? 1 : 0));
const recallVec = (lists) =>
  lists.map((files, i) => {
    const top = new Set(files.slice(0, K));
    return [...CASES[i].gt].filter((f) => top.has(f)).length / CASES[i].gt.size;
  });
const mrrVec = (lists) =>
  lists.map((files, i) => {
    for (let r = 0; r < Math.min(K, files.length); r += 1) {
      if (CASES[i].gt.has(files[r])) return 1 / (r + 1);
    }
    return 0;
  });
const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (x) => +(x * 100).toFixed(1);

/**
 * 配对 bootstrap 95% CI（固定种子）。
 * @param {readonly number[]} delta 逐查询差值。
 * @param {number} rounds 重采样轮数。
 * @returns {[number, number]} CI（百分点）。
 */
function pairedCI(delta, rounds = 4000) {
  let seed = 0x5eed1e;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let r = 0; r < rounds; r += 1) {
    let s = 0;
    for (let i = 0; i < delta.length; i += 1) s += delta[Math.floor(rnd() * delta.length)];
    out.push((s / delta.length) * 100);
  }
  out.sort((a, b) => a - b);
  return [+out[Math.floor(0.025 * rounds)].toFixed(2), +out[Math.floor(0.975 * rounds)].toFixed(2)];
}

/**
 * repeated 2-fold 留出折：统计"折上为负"的次数（第二关）。
 * @param {readonly number[]} delta 逐查询差值。
 * @param {number} reps 重复轮数。
 * @returns {{neg: number, total: number, min: number}} 折统计。
 */
function folds(delta, reps = 20) {
  let seed = 0x9e3779b9;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let r = 0; r < reps; r += 1) {
    const ix = delta.map((_, i) => i);
    for (let i = ix.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [ix[i], ix[j]] = [ix[j], ix[i]];
    }
    const half = Math.floor(ix.length / 2);
    out.push(avg(ix.slice(0, half).map((i) => delta[i])) * 100);
    out.push(avg(ix.slice(half).map((i) => delta[i])) * 100);
  }
  return {
    neg: out.filter((x) => x < -1e-9).length,
    total: out.length,
    min: +Math.min(...out).toFixed(2),
  };
}

const baseLists = order(VARIANTS['V0 现生产式（rr+覆盖）']);
const baseHit = hitVec(baseLists);
const baseRec = recallVec(baseLists);
const baseMrr = mrrVec(baseLists);
const results = {};
console.log(
  `  基线 V0 绝对值：hit@${String(K)} ${String(pct(avg(baseHit)))}% ｜ recall@${String(K)} ${String(pct(avg(baseRec)))}% ｜ MRR ${avg(baseMrr).toFixed(3)}\n`,
);

/**
 * 汇总一个变体（含两关统计）。
 * @param {string} name 变体名。
 * @param {readonly string[][]} lists 排序结果。
 * @returns {object} 该变体的统计。
 */
function summarize(name, lists) {
  const hit = hitVec(lists);
  const rec = recallVec(lists);
  const mrr = mrrVec(lists);
  const dHit = hit.map((v, i) => v - baseHit[i]);
  const dRec = rec.map((v, i) => v - baseRec[i]);
  const dMrr = mrr.map((v, i) => v - baseMrr[i]);
  const f = folds(dMrr);
  const tier = (t) =>
    pct(
      avg(
        CASES.map((c, i) => ({ c, i }))
          .filter(({ c }) => c.tier === t)
          .map(({ i }) => hit[i]),
      ),
    );
  results[name] = {
    hitRate: pct(avg(hit)),
    recall: pct(avg(rec)),
    mrr: +avg(mrr).toFixed(4),
    hitDeltaCI: pairedCI(dHit),
    recallDeltaCI: pairedCI(dRec),
    mrrDeltaCI: pairedCI(dMrr),
    mrrFolds: f,
    core: tier('core'),
    ext: tier('ext'),
    hitUpDown: [dHit.filter((x) => x > 0).length, dHit.filter((x) => x < 0).length],
    mrrUpDown: [dMrr.filter((x) => x > 1e-9).length, dMrr.filter((x) => x < -1e-9).length],
  };
  const r = results[name];
  console.log(
    `  ${name.padEnd(22)} hit@${String(K)}=${String(r.hitRate).padStart(5)}% ΔCI ${JSON.stringify(r.hitDeltaCI)}pp (↑${String(r.hitUpDown[0])}/↓${String(r.hitUpDown[1])})  ` +
      `recall=${String(r.recall).padStart(5)}% ΔCI ${JSON.stringify(r.recallDeltaCI)}pp  ` +
      `MRR=${r.mrr.toFixed(3)} ΔCI ${JSON.stringify(r.mrrDeltaCI)}  折负(MRR) ${String(f.neg)}/${String(f.total)}(min ${String(f.min)}pp)`,
  );
  return r;
}

/** 判定结论（两关都过才算"有增益"）。 */
function verdictOf(r) {
  const ci = r.mrrDeltaCI;
  const crossesZero = ci[0] <= 0 && ci[1] >= 0;
  const foldsNegative = r.mrrFolds.neg > 0;
  return crossesZero || foldsNegative
    ? '不成立（CI 跨 0 或折负）'
    : '两关通过（CI 不跨 0 且折无负）';
}

for (const [name, fn] of Object.entries(VARIANTS)) {
  if (ONLY !== '' && !ONLY.split(',').some((v) => name.startsWith(v))) continue;
  summarize(name, order(fn));
}
for (const lambda of [0.25, 0.5]) {
  summarize(`V6 MMR λ=${String(lambda)}`, mmrOrder(lambda));
}

// 第二段净效果（V0 相对「完全不重排」）：本仓「精排是否值得开」的判定量。
const offLists = order(VARIANTS['V_off 第一段（不重排）']);
const offHit = hitVec(offLists);
const offRec = recallVec(offLists);
const offMrr = mrrVec(offLists);
const net = {
  hitDeltaCI: pairedCI(baseHit.map((v, i) => v - offHit[i])),
  recallDeltaCI: pairedCI(baseRec.map((v, i) => v - offRec[i])),
  mrrDeltaCI: pairedCI(baseMrr.map((v, i) => v - offMrr[i])),
  mrrFolds: folds(baseMrr.map((v, i) => v - offMrr[i])),
};
console.log(
  `\n  [第二段净效果 V0 − V_off] hit ΔCI ${JSON.stringify(net.hitDeltaCI)}pp  recall ΔCI ${JSON.stringify(net.recallDeltaCI)}pp  ` +
    `MRR ΔCI ${JSON.stringify(net.mrrDeltaCI)}（折负 ${String(net.mrrFolds.neg)}/${String(net.mrrFolds.total)}）`,
);
console.log(`  判定：${verdictOf({ mrrDeltaCI: net.mrrDeltaCI, mrrFolds: net.mrrFolds })}`);
for (const [name, r] of Object.entries(results)) {
  console.log(`  ${name.padEnd(22)} ⇒ ${verdictOf(r)}`);
}

if (JSON_OUT !== '') {
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify(
      {
        probe: 'rerankDiscriminatorAb',
        K,
        POOL,
        queries: CASES.length,
        baseline: {
          hit: pct(avg(baseHit)),
          recall: pct(avg(baseRec)),
          mrr: +avg(baseMrr).toFixed(4),
        },
        net,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n已写出 ${JSON_OUT}`);
}
