#!/usr/bin/env node
// 精排**判别器**变体的受控对照（R1 调研仪器，2026-09-27）。
//
// ## 为什么需要它
//
// `src/context/fileReranker.ts` 的模块头登记了一个失败形态：**兄弟文件抬升**——查询词是通用前缀
// （`tool` / `sandbox` / `server`）时，同前缀的兄弟文件被一起抬起，真定义处被挤出预算。第一轮修法
// （稀有词门：分子只计 IDF ≥ 系数 × 最强词的词）已实测**证伪**。要回答「换判别器是否有增益」，必须：
//   ① 同一候选池、同一公式骨架，**只换判别器一项**（受控）；
//   ② 成对 bootstrap 95% CI + repeated 2-fold 留出折（本仓「两关」纪律）；
//   ③ 足够的**判定力**（84 条时成对 CI 宽达 ±7pp，「1–3pp」级问题不可判）——故 2026-09-27 把查询集
//      扩到 193 条（见 `tests/fixtures/recallQueries.ts`）。
//
// ## 变体（统一骨架：`score = 倒数秩 rr + 覆盖率`，只有覆盖率口径不同）
//
//   V_off  不重排（参照系：回答「第二段净效果」）
//   V0     现生产式：分子按「该文件**声明的符号名**是否含该词」计（现状）
//   V1     纯覆盖率（去名次项，名次仅作同分次序）
//   V11    词项独占：某词项的分子只给「声明该词且第一段名次最好」的那一个候选，其余得 0
//   V12    认领摊分：某词项的分子按「候选池内声明该词的文件数 n」摊分（每个得 w/n）
//   V13    软独占（**在扩样本之前预注册**）：最浅名次认领者取全额，其余按 w/n 保留部分信用
//   V6     确定性 MMR：贪婪选取，得分 = 基础分 − λ × 与**已选文件**的最大符号名 Jaccard（λ=0.25/0.5）
//
// ## 2026-09-27 实测结论（193 条已复核查询 / K=20 / pool=400，见同名 .report.json）
//
// | 变体 | hit@20 | ΔCI（对 V0） | recall@20 | MRR |
// | --- | --- | --- | --- | --- |
// | V0 现生产式 | 44.0% | — | 31.5% | 0.138 |
// | V11 词项独占 | 44.0% | [−5.18, +5.18]pp | 29.1% | 0.147 |
// | V12 认领摊分 | 44.6% | [−3.63, +4.66]pp | 30.3% | 0.152 |
// | V13 软独占 | 44.6% | [−3.63, +4.66]pp | 30.3% | 0.146 |
// | V1 纯覆盖 | 39.9% | [−7.25, −1.04]pp ❌ | 27.7% | 0.109 |
// | V6 MMR λ=0.25 | 43.0% | [−3.63, +1.55]pp | 30.0% | 0.136 |
//
// **判定：全部变体都没能显著超过现生产式**（无一 CI 下界 > 0），且**去掉名次项的 V1 显著更差**
// （CI 上界 < 0）⇒ 现有「倒数秩 + IDF 加权符号名覆盖」这一组合**被反向确认是合理的**。
// 诚实登记一条**小样本教训**：V11/V12 在 84 条上曾给出 MRR 的「显著」增益（ΔCI [0.5, 4.06]、
// 留出折 0/40 为负），扩到 193 条后 CI 跨 0（[−0.41, +2.27]）——这正是本次扩样本的目的：
// 把「在噪声里读出来的增益」按下去。**结论：判别器不改**（`fileReranker.ts` 保持原式）。
//
// 用法：node evals/rerank-discriminator-ab.mjs [K] [--pool N]
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { FileRerankIndex } = await importDist('context', 'fileRerankIndex.js');

const K = Number(process.argv[2] ?? 20);
const poolArg = process.argv.indexOf('--pool');
const POOL = poolArg >= 0 ? Number(process.argv[poolArg + 1]) : 400;

const { RECALL_QUERIES, CORE_COUNT, FROZEN_COUNT } = await import(
  pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
);

const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { morph: true, light: true });
const idx = new FileRerankIndex();
console.log(
  `语料 ${corpus.files.length} 文件 / ${corpus.symbols.length} 符号 ｜ 查询 ${RECALL_QUERIES.length} 条 ｜ K=${K} ｜ pool=${POOL}\n`,
);

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
    tier: i < CORE_COUNT ? 'core' : i < FROZEN_COUNT ? 'frozen84' : 'growth',
  });
}
console.log(`有效查询 ${CASES.length}/${RECALL_QUERIES.length}\n`);

const namesOf = new Map();
const names = (rel) => {
  let s = namesOf.get(rel);
  if (s === undefined) {
    s = idx.nameTerms(corpus, rel);
    namesOf.set(rel, s);
  }
  return s;
};

/** 覆盖率共用部分：每个词项的权重与「哪些候选声明了它」。 */
function termsOf(q, cands) {
  const terms = idx.contentTerms(corpus, q);
  const weights = terms.map((t) => idx.weight(corpus, t));
  const total = weights.reduce((a, b) => a + b, 0);
  const claimants = terms.map((t) => {
    const set = new Set();
    cands.forEach((rel, i) => {
      if (names(rel).has(t)) set.add(`${i}\u0000${rel}`);
    });
    return set;
  });
  return { terms, weights, total, claimants };
}

const covOf = (i, rel, weights, claimants, mode) => {
  let got = 0;
  for (let k = 0; k < weights.length; k += 1) {
    const claim = claimants[k];
    if (!claim.has(`${i}\u0000${rel}`)) continue;
    if (mode === 'split') got += weights[k] / claim.size;
    else if (mode === 'exclusive' || mode === 'soft') {
      // 独占：命中最浅名次者取全部（同分取路径字典序最小，保持确定性）。
      const winner = [...claim].sort((a, b) => {
        const [ai, ar] = a.split('\u0000');
        const [bi, br] = b.split('\u0000');
        return Number(ai) - Number(bi) || (ar < br ? -1 : 1);
      })[0];
      const mine = `${i}\u0000${rel}`;
      if (winner === mine) got += weights[k];
      else if (mode === 'soft') got += weights[k] / claim.size;
    } else got += weights[k];
  }
  return got;
};

const order = (scoreFn) =>
  CASES.map(({ q, gt, cands }) => {
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
  // 参照系：完全不重排（保持第一段次序）。用于回答「第二段净效果」。
  'V_off 第一段（不重排）': (_rel, i) => -i,
  'V0 现生产式（rr+覆盖）': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'plain') / total,
  'V1 纯覆盖（无名次项）': (rel, i, w, c, total) => covOf(i, rel, w, c, 'plain') / total,
  'V11 词项独占 + rr': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'exclusive') / total,
  'V12 认领摊分 + rr': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'split') / total,
  // V13（预注册于扩样本之前）：软独占——最浅名次认领者取全额，其余仍按 1/n 保留部分信用。
  'V13 软独占 + rr': (rel, i, w, c, total) =>
    1 / (1 + (i + 1)) + covOf(i, rel, w, c, 'soft') / total,
};

/** V6 确定性 MMR：贪婪，每次取「基础分 − λ·与已选最大 Jaccard」。 */
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
/** 召回@K：GT 文件被排进前 K 的比例（连续量，方差低于二值命中率）。 */
const recallVec = (lists) =>
  lists.map((files, i) => {
    const top = new Set(files.slice(0, K));
    return [...CASES[i].gt].filter((f) => top.has(f)).length / CASES[i].gt.size;
  });
/** 首个 GT 命中的倒数名次（池内不可达记 0）。 */
const mrrVec = (lists) =>
  lists.map((files, i) => {
    for (let r = 0; r < Math.min(K, files.length); r += 1) {
      if (CASES[i].gt.has(files[r])) return 1 / (r + 1);
    }
    return 0;
  });
const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (x) => +(x * 100).toFixed(1);

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
const results = {};
const summarize = (name, lists) => {
  const hit = hitVec(lists);
  const rec = recallVec(lists);
  const mrr = mrrVec(lists);
  const dHit = hit.map((v, i) => v - baseHit[i]);
  const dRec = rec.map((v, i) => v - baseRec[i]);
  const dMrr = mrr.map((v, i) => v - baseMrr[i]);
  const f = folds(dMrr);
  const tier = (t) => {
    const ix = CASES.map((c, i) => (c.tier === t ? i : -1)).filter((i) => i >= 0);
    return pct(avg(ix.map((i) => hit[i])));
  };
  results[name] = {
    hitRate: pct(avg(hit)),
    recall: pct(avg(rec)),
    mrr: +avg(mrr).toFixed(4),
    hitDeltaCI: pairedCI(dHit),
    recallDeltaCI: pairedCI(dRec),
    mrrDeltaCI: pairedCI(dMrr),
    mrrFolds: f,
    core: tier('core'),
    frozen84: tier('frozen84'),
    growth: tier('growth'),
    hitUpDown: [dHit.filter((x) => x > 0).length, dHit.filter((x) => x < 0).length],
    mrrUpDown: [dMrr.filter((x) => x > 1e-9).length, dMrr.filter((x) => x < -1e-9).length],
  };
  const r = results[name];
  console.log(
    `  ${name.padEnd(22)} hit@${K}=${String(r.hitRate).padStart(5)}% ΔCI ${JSON.stringify(r.hitDeltaCI)}pp (↑${r.hitUpDown[0]}/↓${r.hitUpDown[1]})  ` +
      `recall=${String(r.recall).padStart(5)}% ΔCI ${JSON.stringify(r.recallDeltaCI)}pp  ` +
      `MRR=${r.mrr.toFixed(3)} ΔCI ${JSON.stringify(r.mrrDeltaCI)}  折负(MRR) ${f.neg}/${f.total}(min ${f.min}pp)`,
  );
  return r;
};
const baseHit = hitVec(baseLists);
const baseRec = recallVec(baseLists);
const baseMrr = mrrVec(baseLists);
console.log(
  `  基线 V0 绝对值：hit@${K} ${pct(avg(baseHit))}% ｜ recall@${K} ${pct(avg(baseRec))}% ｜ MRR ${avg(baseMrr).toFixed(3)}\n`,
);
for (const [name, fn] of Object.entries(VARIANTS)) {
  summarize(name, order(fn));
}

for (const lambda of [0.25, 0.5]) {
  summarize(`V6 MMR λ=${lambda}`, mmrOrder(lambda));
}

// 第二段净效果（V0 相对「完全不重排」）：本仓「精排是否值得开」的判定量。
const offLists = order(VARIANTS['V_off 第一段（不重排）']);
const dOffHit = hitVec(baseLists).map((v, i) => v - hitVec(offLists)[i]);
const dOffRec = recallVec(baseLists).map((v, i) => v - recallVec(offLists)[i]);
const dOffMrr = mrrVec(baseLists).map((v, i) => v - mrrVec(offLists)[i]);
console.log(
  `\n  [第二段净效果 V0 − V_off] hit ΔCI ${JSON.stringify(pairedCI(dOffHit))}pp  recall ΔCI ${JSON.stringify(pairedCI(dOffRec))}pp  MRR ΔCI ${JSON.stringify(pairedCI(dOffMrr))}（折负 ${folds(dOffMrr).neg}/${folds(dOffMrr).total}）`,
);

writeFileSync(
  join(ROOT, 'evals', `rerank-discriminator-ab.report.json`),
  JSON.stringify(
    {
      eval: 'rerank-discriminator-ab',
      generatedAt: new Date().toISOString(),
      purpose:
        'R1：精排判别器变体的受控对照（同池同骨架，只换判别器）。用于判定「兄弟文件抬升」的修法是否有净增益。',
      decisionBasis:
        '两关：成对 bootstrap 95% CI 下界 > 0 且 repeated 2-fold 留出折多数为正（同仓纪律）。',
      decision:
        'no-change（2026-09-27：全部变体 CI 下界 ≤ 0；去掉名次项的 V1 显著更差 ⇒ 保持现式）',
      K,
      POOL,
      queries: CASES.length,
      querySource: 'tests/fixtures/recallQueries.ts（all193）',
      baseline: {
        hit: pct(avg(baseHit)),
        recall: pct(avg(baseRec)),
        mrr: +avg(baseMrr).toFixed(4),
      },
      results,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/rerank-discriminator-ab.report.json');
