#!/usr/bin/env node
// 召回 A/B 的**显著性 + 检验力**分析（零成本、零网络、只用已有报告数据）。
//
// 为什么需要它（2026-09-26）：`evals/semantic-recall-ab.mjs` 把「语义路默认开」的判据定成
// 「配对 bootstrap CI 不跨 0」，实测全部档位都跨 0 ⇒ 全判「不显著」。但「不显著」有两种完全不同的含义，
// 报告本身分不出来：
//   ① 真的没有效应；② **样本量不够**（检验力不足），有效应也测不出来。
// 二者对「要不要翻默认」的结论相反，故必须把**检验力**算出来：
//   - 用配对设计里真正携带信息的量——**不一致对**（一路命中、另一路未命中）；
//   - 给出精确 McNemar 检验（配对二分类的正确检验，比独立比例检验敏感）；
//   - 给出「按当前观测效应，要达到 80% 检验力还需多少条查询」——这是可执行的下一步，而非"再跑跑看"。
//
// ⚠️ 必须**逐场景**分析而不是只挑一个：实测默认权重档 Δ=+1.2pp，而调过的 `semWeight=1.5` 档 Δ=+4.8pp；
// 只报后者等于把调参结果当成默认收益（也正是「语义该不该默认开」长期说不清的根因之一）。
//
// 用法：node evals/recall-significance.mjs [--report <file>] [--baseline <label>]
// 输出：控制台表 + evals/recall-significance.report.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** 取 `--name value` 参数（缺省回落）。 */
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const REPORT = arg('--report', join(ROOT, 'evals', 'semantic-recall-ab.report.json'));
const BASE_LABEL = arg('--baseline', '基线（纯 BM25 + 精排 + K=20 + 梯度）');
const BOOTSTRAP_N = 20000;
const SEED = 20260926;

/** 确定性伪随机（xorshift32）：重跑得到同一 CI——报告必须可复现。 */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** 对数组合数（n 小，直接累加避免溢出）。 */
function logChoose(n, k) {
  let acc = 0;
  for (let i = 1; i <= k; i++) acc += Math.log(n - k + i) - Math.log(i);
  return acc;
}

/**
 * 精确 McNemar 检验（条件于不一致对数；零假设 = 两个方向等概率）。
 * @param {number} b 基线未命中 → 实验命中（改善方向）
 * @param {number} c 基线命中 → 实验未命中（回退方向）
 * @returns {{pTwoSided:number, pOneSidedGain:number, n:number}} p 值与不一致对总数
 */
function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { pTwoSided: 1, pOneSidedGain: 1, n: 0 };
  const logHalf = n * Math.log(0.5);
  const pmf = (k) => Math.exp(logChoose(n, k) + logHalf);
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) tail += pmf(k);
  const pTwoSided = Math.min(1, 2 * tail);
  let upper = 0;
  for (let k = b; k <= n; k++) upper += pmf(k);
  return { pTwoSided, pOneSidedGain: upper, n };
}

/**
 * 配对 bootstrap：对逐条差值重采样（与 A/B 脚本同口径，便于对齐）。
 * @param {number[]} diffs 每条查询的差值（+1/0/−1）
 * @returns {{mean:number, lo:number, hi:number}} 均值与 95% 分位区间（单位 pp）
 */
function pairedBootstrap(diffs) {
  const rng = makeRng(SEED);
  const n = diffs.length;
  const means = [];
  for (let it = 0; it < BOOTSTRAP_N; it++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += diffs[Math.floor(rng() * n)];
    means.push(acc / n);
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(means.length - 1, Math.floor(p * means.length))] * 100;
  return { mean: (diffs.reduce((a, b) => a + b, 0) / n) * 100, lo: q(0.025), hi: q(0.975) };
}

/** 标准正态 CDF（Abramowitz–Stegun 7.1.26 近似）。 */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * 「需要多少条查询才能有 80% 检验力」：按观测到的不一致率与方向偏好外推。
 * @param {number} b 改善方向对数
 * @param {number} c 回退方向对数
 * @param {number} total 本次查询总数
 * @returns {{requiredDiscordant:number, requiredQueries:number|null, power:number, discordanceRate:number}} 检验力外推
 */
function requiredSample(b, c, total) {
  const n = b + c;
  const discordanceRate = n / total;
  if (n === 0) {
    return { requiredDiscordant: Infinity, requiredQueries: null, power: 0, discordanceRate };
  }
  const p = b / n;
  const powerAt = (m) => {
    const z = 1.959964;
    const crit = 0.5 + (z * Math.sqrt(m)) / (2 * m);
    const sd = Math.sqrt(p * (1 - p) * m) || 1;
    return 1 - normalCdf((crit * m - p * m) / sd);
  };
  let m = 1;
  for (; m <= 200000; m++) if (powerAt(m) >= 0.8) break;
  return {
    requiredDiscordant: m,
    requiredQueries: Math.ceil(m / discordanceRate),
    power: powerAt(n),
    discordanceRate,
  };
}

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const baseRaw = report.results.find((r) => r.label === BASE_LABEL);
if (baseRaw === undefined) {
  console.error(`❌ 报告里找不到基线场景：${BASE_LABEL}`);
  console.error(`   可用：${report.results.map((r) => r.label).join(' | ')}`);
  process.exit(1);
}
const scenariosRaw = report.results.filter((r) => r.label !== BASE_LABEL);
if (scenariosRaw.length === 0) {
  console.error(`❌ 除基线外没有可比场景（baseline=${BASE_LABEL}）`);
  process.exit(1);
}

// —— 条件子集（2026-09-26 新增，回答「机制在哪里起作用」）——
// 动机：语义路的设计目标是补 BM25 的**词法盲区**，但摊在全部 84 条查询上测会被大量「BM25 本来就能命中」
// 的查询稀释（实测：84 条里只有 ~11 条不一致对 ⇒ 检验力仅个位数百分比）。故增加一个**预登记**的条件估计量：
// 「在 BM25 未命中的那些查询上，混合路能捞回多少」。
// ⚠️ 口径纪律：这是**条件估计量**（对基线失败取条件，存在选择效应），它回答「机制有没有在起作用」，
// **不能**直接当作「该不该把语义路默认打开」的依据——后者需要无条件口径（或一个不依赖真值的触发规则）。
const SUBSET = arg('--subset', 'all');
const includeIdx = [];
for (let i = 0; i < baseRaw.perQuery.length; i += 1) {
  if (SUBSET === 'baseline-miss' ? baseRaw.perQuery[i].hit === 0 : true) includeIdx.push(i);
}
if (includeIdx.length === 0) {
  console.error(`❌ 子集 "${SUBSET}" 为空（基线未命中的查询为 0 条）`);
  process.exit(1);
}
/** 按 includeIdx 裁出子集场景（保持字段结构，hitRate 由子集重算）。 */
const subsetOf = (s) => {
  const perQuery = includeIdx.map((i) => s.perQuery[i]);
  const hitRate = perQuery.reduce((a, q) => a + q.hit, 0) / perQuery.length;
  return { ...s, perQuery, hitRate };
};
const base = subsetOf(baseRaw);
const scenarios = scenariosRaw.map(subsetOf);
if (SUBSET !== 'all') {
  console.log(
    `[subset=${SUBSET}] 基线未命中 ${includeIdx.length}/${baseRaw.perQuery.length} 条 —— ` +
      '条件估计量：只回答「机制有没有起作用」，不能直接当默认开关的依据。\n',
  );
}

// 单位归一：报告里 `hitRate` 是**百分数**（61.9），perQuery 的 `hit` 是 0/1。
// 下面这条自证当场抓到过一次单位错配（把 61.9 又乘了 100），故保留。
const asFraction = (v) => (v > 1 ? v / 100 : v);
const meanOf = (s) => s.perQuery.reduce((a, q) => a + q.hit, 0) / s.perQuery.length;
for (const s of [base, ...scenarios]) {
  if (Math.abs(meanOf(s) - asFraction(s.hitRate)) > 0.005) {
    console.error(
      `❌ 取数自证失败：${s.label} 的 perQuery 均值 ${meanOf(s)} 与 hitRate ${s.hitRate} 不符`,
    );
    process.exit(1);
  }
}

/**
 * 对单个场景做完整配对分析。
 * @param {object} treat 实验场景（含 perQuery/hitRate）。
 * @returns {object} 分析结果（差值、CI、不一致对、McNemar、检验力、结论）。
 */
function analyze(treat) {
  const diffs = base.perQuery.map((q, i) => treat.perQuery[i].hit - q.hit);
  let b = 0;
  let c = 0;
  for (const d of diffs) {
    if (d > 0) b++;
    else if (d < 0) c++;
  }
  const boot = pairedBootstrap(diffs);
  const mc = mcnemarExact(b, c);
  const power = requiredSample(b, c, diffs.length);
  const verdict =
    boot.lo > 0 || boot.hi < 0
      ? boot.mean > 0
        ? '显著改善（配对 bootstrap）'
        : '显著回退（配对 bootstrap）'
      : mc.pTwoSided < 0.05
        ? mc.pOneSidedGain < 0.5
          ? '显著改善（精确 McNemar）'
          : '显著回退（精确 McNemar）'
        : '不显著';
  return {
    label: treat.label,
    hitRate: asFraction(treat.hitRate),
    deltaPp: (asFraction(treat.hitRate) - asFraction(base.hitRate)) * 100,
    pairedBootstrap: {
      mean: boot.mean,
      ci: [boot.lo, boot.hi],
      resamples: BOOTSTRAP_N,
      seed: SEED,
    },
    discordant: { improved: b, regressed: c },
    mcnemarExact: mc,
    power,
    verdict,
  };
}

const analyses = scenarios.map(analyze);
const f = (n) => Number(n).toFixed(1);
console.log(`=== 召回 A/B 显著性与检验力（${REPORT.split(/[\\/]/).pop()}）===`);
console.log(
  `基线：${base.label}  hitRate=${f(asFraction(base.hitRate) * 100)}%  查询数 n=${base.perQuery.length}`,
);
console.log('');
console.log(
  '场景'.padEnd(38) + 'Δpp    CI95(pp)      改善/回退   McNemar p   检验力   需多少查询  结论',
);
for (const a of analyses) {
  console.log(
    a.label.padEnd(38) +
      f(a.deltaPp).padStart(6) +
      `  [${f(a.pairedBootstrap.ci[0])}, ${f(a.pairedBootstrap.ci[1])}]`.padEnd(16) +
      `${a.discordant.improved}/${a.discordant.regressed}`.padEnd(11) +
      f(a.mcnemarExact.pTwoSided).padStart(9) +
      `   ${f(a.power.power * 100)}%`.padEnd(9) +
      String(a.power.requiredQueries).padStart(8) +
      '   ' +
      a.verdict,
  );
}
console.log('');
console.log(
  '读法：携带信息的只有「不一致对」（一路命中、另一路未命中）；同命中/同未命中都不提供证据。',
);
console.log(
  '      检验力是按**当前观测效应**外推的现有样本检验力——它低，则「不显著」多半是样本不够，而非没有效应。',
);

writeFileSync(
  join(__dirname, 'recall-significance.report.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: REPORT,
      baseline: { label: base.label, hitRate: asFraction(base.hitRate), n: base.perQuery.length },
      analyses,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/recall-significance.report.json');
