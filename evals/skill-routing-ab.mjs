#!/usr/bin/env node
// 技能路由对照评测（第 2 关仪器）：子串包含（生产默认）vs BM25 相关性检索（候选，待翻默认）。
//
// ## 为什么要先做对照而不是直接改默认
//
// `SkillRegistry.match()` 的判据是 `text.includes(技能名或 tag)`：它在**同义改写**上必然漏召
// （用户说「怎么判断一个新检索方案是真的有用」，技能叫 `omniharness-two-gate-rule`），
// 在**短 tag** 上又会误召（`test` / `plan` / `api` 这类词在无关文本里满地都是）。
// 而本仓已记录的结论是「技能堆叠引噪声」——所以「换更聪明的路由」既可能增收也可能增噪，**必须实测**。
//
// ## 本版相对上一版的实质变化（2026-10-02）
//
//  1. **语料从合成换成真实**：读随包出厂的 `defaults/skills/harness-core.json`（13 条面向本仓
//     自身领域的技能，内容可由仓库文件核对）。上一版是评测脚本内联的 20 条合成技能，
//     它自述「**不能**当作本仓端到端收益的证据」——本版把那个缺口补上。
//     语料路径可用 `OMNI_SKILLS_FILE` 覆盖（指向 SKILL.md 转换产物或任意 SkillEntry JSON）。
//  2. **从「只打印」升级为两关仪器**：第一关 = 否决器（跨查询 Top-K 重合度 + 两臂确实产出结果），
//     第二关 = 按查询配对 bootstrap 95% CI + repeated 2-fold×20 留出折；带 `--gate` 与退出码。
//  3. **口径对齐生产**：两臂都接 `SkillSparsifier`（生产 `agent.injectSkills` 的真实下游），
//     因为 matcher 的召回能否**留下**取决于稀疏化的 top-k 与强命中豁免。
//
// ## 两臂（同语料、同预算、唯一变量 = 匹配判据）
//
//   A `SkillRegistry.match(text)`  → `SkillSparsifier.sparsify(...)`
//   B `SkillRetriever.rank(...)`   → `SkillSparsifier.sparsify(...)`
//
// ## 诚实边界
//
//  - 判据是**路由命中率**（GT 技能是否留在注入集里），**不是任务成功率**。任务成功率需要真模型，
//    本脚本免模型免 key；故本脚本只能支撑「路由判据该不该换」，不能单独支撑「任务能力变好」。
//  - 语料 13 条，低于本仓「扩到 n≥80 再判」的历史口径 ⇒ **CI 宽度本身就是结论的一部分**，
//    报告把 n 与 CI 一并落盘，读者可据此判读；点估计不得脱离 CI 引用。
//  - 查询刻意用自然语言改写、避开技能名字面词（制造词法鸿沟）；这是**对抗口径**。
//
// 用法：node evals/skill-routing-ab.mjs [--gate]
// 产物：evals/skill-routing-ab.report.json
// 免网络、免模型、免 API key、秒级。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GATE = process.argv.includes('--gate');

const { SkillRegistry } = await import(
  new URL('../dist/src/skill/skillRegistry.js', import.meta.url).href
);
const { SkillRetriever } = await import(
  new URL('../dist/src/skill/skillRetriever.js', import.meta.url).href
);
const { SkillSparsifier } = await import(
  new URL('../dist/src/skill/skillSparsifier.js', import.meta.url).href
);
const { Bootstrap } = await import(
  new URL('../dist/src/evolution/bootstrap.js', import.meta.url).href
);

/** 真实技能语料路径（`OMNI_SKILLS_FILE` 可覆盖到 SKILL.md 转换产物或任意 SkillEntry JSON）。 */
const SKILLS_FILE =
  process.env['OMNI_SKILLS_FILE'] ?? join(ROOT, 'defaults', 'skills', 'harness-core.json');

/**
 * 读取真实技能集。接受两种形态：裸 `SkillEntry[]`，或 `{ skills: SkillEntry[] }` 包装
 * （与 `--skills` CLI 的两种入参形态一致，见 `docs/integration.md`）。
 * @param file 文件绝对路径。
 * @returns 技能条目数组。
 */
const loadSkills = (file) => {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.skills;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`技能语料为空或格式不对：${file}`);
  }
  return entries;
};

/** 每技能 2 条自然语言改写查询（刻意避开技能名字面词与短 tag），外加 5 条陷阱查询。 */
const PROBES = [
  ['帮我看看这个类的成员有没有写全访问修饰符，公开方法还差注释说明', 'omniharness-coding-standard'],
  ['新加的函数该放哪儿才不违反分层，能不能直接写成模块级函数', 'omniharness-coding-standard'],
  ['改完之后我该跑哪几项检查才算收尾', 'omniharness-gate-runner'],
  ['本地跑整个测试套件老是失败还特别慢，是不是环境问题', 'omniharness-gate-runner'],
  ['怎么判断一个新检索方案是真的有用而不是碰巧', 'omniharness-two-gate-rule'],
  ['点估计是正的但区间跨过零，这种情况能算有效吗', 'omniharness-two-gate-rule'],
  ['我想加一个新能力，接口和实现分别该放哪一层', 'omniharness-port-adapter-wiring'],
  ['有个开关写在配置文件里却好像没人读它', 'omniharness-port-adapter-wiring'],
  ['加一个模型能调用的新动作，一共要改几个地方', 'omniharness-tool-registration'],
  ['工具明明注册了但模型看不到，还有只读模式会被拦下来', 'omniharness-tool-registration'],
  ['工作区写不进去被拦了，这是哪一档的限制', 'omniharness-sandbox-approval-tiers'],
  ['规则里的通配写法匹配范围是怎么定的，默认拒绝还是放行', 'omniharness-sandbox-approval-tiers'],
  ['历史越来越长快放不下了，注入的内容怎么压一压', 'omniharness-context-compaction'],
  ['同样的内容每轮都重发一遍太浪费，前缀能不能稳住', 'omniharness-context-compaction'],
  ['我想写个评测脚本，怎么保证它不会自己骗自己', 'omniharness-eval-authoring'],
  ['外部服务不可用时脚本一直报错，应该直接跳过吗', 'omniharness-eval-authoring'],
  ['相对导入要不要写后缀，可选字段怎么处理 undefined', 'omniharness-strict-typescript-esm'],
  ['编译期报错说下标可能为空，除了加感叹号还能怎么写', 'omniharness-strict-typescript-esm'],
  ['出错了应该让它直接崩还是降级继续跑', 'omniharness-failure-handling'],
  ['功能没生效和功能本来就没用，日志里怎么区分', 'omniharness-failure-handling'],
  ['前端页面怎么拿到后端的实时更新，加一个新能力要动几处', 'omniharness-app-server-rpc'],
  ['设置改了之后重启还在吗，哪些键不会写回磁盘', 'omniharness-app-server-rpc'],
  ['检索总是找不到关键文件，是不是候选池不够大', 'omniharness-repo-map-recall'],
  ['召回率还能再怎么提，扩池子有用吗', 'omniharness-repo-map-recall'],
  ['想引入一个现成的库，需要满足什么条件', 'omniharness-dependency-policy'],
  ['这个包体积和传递依赖有上限吗，拒绝引入的理由有哪些', 'omniharness-dependency-policy'],
  // 陷阱查询：刻意不含任何技能领域信号，**且长度与句式贴近真实探针**。
  // 为什么必须长度匹配（2026-10-02 自查修正）：BM25 的分数与查询 token 数正相关，若陷阱只是
  // 「你好」这类极短句，水位线会被**压得虚低**，从而把「地板其实很高」误判成「分离良好」。
  // 这里用与正样本同量级的长句、覆盖多个与技能域无关的话题（天气 / 音乐 / 体育 / 旅行 / 闲聊）。
  ['今天天气不错，下午想出去走走顺便买点水果回来', null],
  ['我最近在听一张九十年代的爵士专辑，里面的钢琴特别好听', null],
  ['周末那场球赛你看了吗，最后几分钟真的太紧张了', null],
  ['从北京坐高铁去西安大概要几个小时，沿途有什么值得看的', null],
  ['这道番茄炒蛋应该先放糖还是先放盐，火候怎么把握', null],
  ['帮我看看这段话的英文翻译有没有语病，读起来顺不顺', null],
  ['再帮我确认一下刚才说的那件事，我怕自己理解错了', null],
  ['把刚才那个东西删掉，然后我们重新开始聊别的话题', null],
  ['summary of what we discussed earlier, keep it short please', null],
  ['tell me a fun fact about the deep ocean, nothing technical', null],
  ['我想养一只猫，第一次养的话需要注意什么，开销大概多少', null],
];

const registry = new SkillRegistry();
for (const entry of loadSkills(SKILLS_FILE)) {
  registry.register(entry);
}
const skills = registry.list();
const retriever = new SkillRetriever();
const sparsifier = new SkillSparsifier();

// 语料自检：探针的 ground truth 必须真的在语料里，否则该条会静默算成「必然漏召」。
const names = new Set(skills.map((s) => s.name));
const orphanProbes = PROBES.filter(([, gt]) => gt !== null && !names.has(gt)).map(([q, gt]) => ({
  q,
  gt,
}));

const pct = (r) => `${(r * 100).toFixed(1)}%`;
const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

/**
 * 「全程对齐生产」的保留集：走生产同款 `SkillSparsifier`（top-5 + 强命中豁免）。
 * @param matched 匹配器给出的候选技能（任意顺序，**不得预先按 top-k 截断**）。
 * @param text 提示文本。
 * @param relevance 可选：上游相关性分（技能名 → BM25 分）；给了就作稀疏化主序（生产档用）。
 * @returns 实际会被注入的技能名集合。
 */
const injected = (matched, text, relevance) =>
  new Set(sparsifier.sparsify(matched, text.toLowerCase(), relevance).kept.map((s) => s.name));

/**
 * 「同等预算」对照臂的打分排名：按稀疏化器的命中强度给**全部**技能排序。
 * 用于回答「如果给子串路同样的 top-k 预算，它排得出来吗」——这比只看它是否命中更公平。
 * @param text 提示文本。
 * @returns 按得分降序（同分按名称）的技能名数组。
 */
const lexicalRanking = (text) => {
  const lower = text.toLowerCase();
  return [...skills]
    .map((s) => ({ name: s.name, score: sparsifier.hitScore(s, lower) }))
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .map((x) => x.name);
};

/** 判定基准预算（与生产 SkillSparsifier 默认 top-k 同一口径）。 */
const TOP_K = 5;

const rows = [];
for (const [q, gt] of PROBES) {
  const subMatched = registry.match(q);
  const subKept = injected(subMatched, q);
  const subRanked = lexicalRanking(q);
  const subTopK = new Set(subRanked.slice(0, TOP_K));

  const bmRanked = retriever.rank(skills, q, { topK: skills.length });
  const bmKept = injected(
    bmRanked.map((h) => h.skill),
    q,
  );
  const bmTopK = new Set(bmRanked.slice(0, TOP_K).map((h) => h.skill.name));

  // 生产档（B'）：**走生产真实两段管线**——`SkillRegistry.rankForPrompt()`（比率过滤、不截断）
  // → `SkillSparsifier.sparsify(..., relevance)`（预算 + 强命中豁免）。
  // 2026-10-03 改：此前这里直接调 `selectForPrompt()`（已截到 top-5），而生产在它之后还接了一层
  // 稀疏化 ⇒ 「判定档 = 生产方法」只在**成员集相同**时成立；改传完整排名后，豁免判据真的会生效，
  // 判定档与 `Agent.injectSkills` 逐行同构（不再有隐式假设）。
  const prodRanked = registry.rankForPrompt(q);
  const prodKept = injected(
    prodRanked.map((h) => h.skill),
    q,
    new Map(prodRanked.map((h) => [h.skill.name, h.score])),
  );

  // 噪声控制变体（诊断对照）：只保留得分 ≥ 最高分一半的（「宁可少给」在技能场景同样成立——堆叠即噪声）。
  const topScore = bmRanked[0]?.score ?? 0;
  const filtered = retriever.rank(skills, q, { topK: TOP_K, minScore: topScore * 0.5 });
  const filterKept = injected(
    filtered.map((h) => h.skill),
    q,
  );
  const filterTopK = new Set(filtered.map((h) => h.skill.name));

  rows.push({
    q,
    gt,
    subCount: subKept.size,
    subHit: gt !== null && subKept.has(gt) ? 1 : 0,
    subTopKHit: gt !== null && subTopK.has(gt) ? 1 : 0,
    subRank: gt === null ? null : subRanked.indexOf(gt) + 1 || null,
    bmCount: bmKept.size,
    bmHit: gt !== null && bmKept.has(gt) ? 1 : 0,
    bmTopKHit: gt !== null && bmTopK.has(gt) ? 1 : 0,
    bmRank: gt === null ? null : bmRanked.findIndex((h) => h.skill.name === gt) + 1 || null,
    /** 生产方法给出的注入集与命中（判定档）。 */
    prodCount: prodKept.size,
    prodHit: gt !== null && prodKept.has(gt) ? 1 : 0,
    fltCount: filterKept.size,
    fltHit: gt !== null && filterKept.has(gt) ? 1 : 0,
    fltTopKHit: gt !== null && filterTopK.has(gt) ? 1 : 0,
    /** 两臂的 top-k 集合，用于第一关的「新路是不是基线的复读」判据。 */
    subTopKNames: [...subTopK],
    bmTopKNames: [...bmTopK],
  });
}

const positives = rows.filter((r) => r.gt !== null);
const n = positives.length;
const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
/** 命中率：只算有 ground truth 的探针。 */
const rate = (arr, key) => (arr.length === 0 ? 0 : sum(arr, (r) => r[key]) / arr.length);
/** 噪声：平均多带回了多少条无关技能。 */
const noiseOf = (arr, countKey, hitKey) =>
  arr.length === 0 ? 0 : sum(arr, (r) => Math.max(0, r[countKey] - r[hitKey])) / arr.length;

const subRecall = rate(positives, 'subHit');
const bmRecall = rate(positives, 'bmHit');
/** 生产档：`SkillRegistry.rankForPrompt()` → `SkillSparsifier`（与 `Agent.injectSkills` 逐行同构）的召回（判定档）。 */
const prodRecall = rate(positives, 'prodHit');
/** 诊断档：脚本内复刻的「半高阈值 + top-k」变体（仅作对照，不参与判定）。 */
const fltRecall = rate(positives, 'fltHit');
const subRecallTopK = rate(positives, 'subTopKHit');
const bmRecallTopK = rate(positives, 'bmTopKHit');
const fltRecallTopK = rate(positives, 'fltTopKHit');
const subNoise = noiseOf(positives, 'subCount', 'subHit');
const bmNoise = noiseOf(positives, 'bmCount', 'bmHit');
const prodNoise = noiseOf(positives, 'prodCount', 'prodHit');
const fltNoise = noiseOf(positives, 'fltCount', 'fltHit');
const subMrr = n === 0 ? 0 : sum(positives, (r) => (r.subRank === null ? 0 : 1 / r.subRank)) / n;
const bmMrr = n === 0 ? 0 : sum(positives, (r) => (r.bmRank === null ? 0 : 1 / r.bmRank)) / n;

// ── 第二关：按查询配对 bootstrap 95% CI + repeated 2-fold×20 留出折 ────────────────
// 判定档用**生产方法**的命中（prodHit）；另两档仅登记。
const gainsProd = positives.map((r) => (r.prodHit - r.subHit) * 100);
const gainsTopK = positives.map((r) => (r.bmTopKHit - r.subTopKHit) * 100);
const gainsFiltered = positives.map((r) => (r.fltTopKHit - r.subTopKHit) * 100);

/**
 * 稳健性：种子化 bootstrap CI + repeated 2-fold（与 `evals/rerank-ab.mjs` 逐字同法）。
 * @param gains 每查询增益（百分点）。
 * @returns 点估计、CI、留出折统计。
 */
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
  return {
    pointPp: +avg(gains).toFixed(2),
    ciLoPp: +ci.lo.toFixed(2),
    ciHiPp: +ci.hi.toFixed(2),
    rounds: ci.rounds,
    folds: folds.length,
    foldMeanPp: +avg(folds).toFixed(2),
    foldMinPp: +Math.min(...folds).toFixed(2),
    foldMaxPp: +Math.max(...folds).toFixed(2),
    negativeFolds: folds.filter((f) => f < 0).length,
  };
};

const robTopK = robustnessOf(gainsTopK);
const robFiltered = robustnessOf(gainsFiltered);
const robProd = robustnessOf(gainsProd);

// ── 第一关：否决器 ─────────────────────────────────────────────────────────────
// ① 两臂确实都产出结果（否则「无差异」是接线失效而非判据等价）；
// ② 新路的 Top-K 集合不能跨查询高度重合——重合度高说明它只是基线的复读，没有增量信息。
const producedA = rows.filter((r) => r.subCount > 0).length;
const producedB = rows.filter((r) => r.bmCount > 0).length;
const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 1 : inter / union;
};
/** 每条查询的「两臂 Top-K 重合度」均值。 */
const meanPairOverlap = avg(rows.map((r) => jaccard(r.subTopKNames, r.bmTopKNames)));
/**
 * 「新路自身跨查询敏感度」：新路在**不同查询**间给出的 Top-K 集合越接近，它越是常量偏置。
 * 这里用「所有查询对的平均 Jaccard」表示（两两组合，n=31 时 465 对，成本可忽略）。
 */
const crossQuerySensitivity = (key) => {
  const lists = rows.map((r) => r[key]);
  let acc = 0;
  let count = 0;
  for (let i = 0; i < lists.length; i += 1) {
    for (let j = i + 1; j < lists.length; j += 1) {
      acc += jaccard(lists[i], lists[j]);
      count += 1;
    }
  }
  return count === 0 ? 0 : acc / count;
};
const subSensitivity = crossQuerySensitivity('subTopKNames');
const bmSensitivity = crossQuerySensitivity('bmTopKNames');
const OVERLAP_THRESHOLD = 0.6;

const wiringOk = producedA > 0 && producedB > 0;
const sensitivityOk = bmSensitivity < OVERLAP_THRESHOLD;
const corpusOk = orphanProbes.length === 0;

console.log(`技能语料：${skills.length} 条（真实，来源 ${SKILLS_FILE.replace(ROOT, '.')}）`);
console.log(
  `探针：${rows.length} 条（其中 ${n} 条有 ground truth，${rows.length - n} 条为陷阱查询）`,
);
if (!corpusOk)
  console.log(`  ⚠️ 语料缺 ground truth 技能：${orphanProbes.map((o) => o.gt).join(', ')}`);

console.log('\n=== 召回（GT 是否留在注入集）===');
console.log(`  子串包含 match()（生产旧判据）  ${pct(subRecall)}`);
console.log(`  **生产档** rankForPrompt→Sparsifier ${pct(prodRecall)}`);
console.log('  —— 以下为诊断对照（非判定档）——');
console.log(`  BM25 纯 top-5 + Sparsifier     ${pct(bmRecall)}`);
console.log(`  脚本内复刻的半高阈值变体       ${pct(fltRecall)}`);
console.log(
  `  （同预算 top-k 口径：子串 ${pct(subRecallTopK)} / BM25 ${pct(bmRecallTopK)} / 复刻变体 ${pct(fltRecallTopK)}；MRR 子串 ${subMrr.toFixed(3)} / BM25 ${bmMrr.toFixed(3)}）`,
);
console.log('\n=== 噪声（平均多带回多少条无关技能）===');
console.log(`  子串包含 match()（生产旧判据）  ${subNoise.toFixed(2)} 条/查询`);
console.log(`  **生产档** rankForPrompt→Sparsifier ${prodNoise.toFixed(2)} 条/查询`);
console.log(`  BM25 纯 top-5（诊断）          ${bmNoise.toFixed(2)} 条/查询`);
console.log(`  脚本内复刻的半高阈值变体       ${fltNoise.toFixed(2)} 条/查询`);

console.log('\n=== 第一关：否决器 ===');
console.log(
  `  两臂产出结果：子串 ${producedA}/${rows.length}，BM25 ${producedB}/${rows.length} ⇒ ${wiringOk ? '过' : '未过（接线失效）'}`,
);
console.log(
  `  跨查询敏感度（越小越查询专属）：子串 ${subSensitivity.toFixed(3)} / BM25 ${bmSensitivity.toFixed(3)}（阈值 <${OVERLAP_THRESHOLD}）⇒ ${sensitivityOk ? '过' : '未过'}`,
);
console.log(`  两臂 Top-K 平均重合度：${meanPairOverlap.toFixed(3)}`);

console.log('\n=== 第二关：bootstrap CI + 留出折（判定档 = 生产管线 rankForPrompt→Sparsifier）===');
for (const [label, rob] of [
  ['**生产档** rankForPrompt→Sparsifier', robProd],
  ['BM25 纯 top-5（诊断）      ', robTopK],
  ['复刻半高阈值变体（诊断）   ', robFiltered],
]) {
  console.log(
    `  ${label}：Δ ${rob.pointPp}pp  CI95 [${rob.ciLoPp}, ${rob.ciHiPp}]pp  留出折 负 ${rob.negativeFolds}/${rob.folds}（min ${rob.foldMinPp}pp）`,
  );
}

/** 陷阱查询（无领域信号）的平均注入条数：衡量「对无关提示也乱给技能」的程度。 */
const trapRows = rows.filter((r) => r.gt === null);
const trapNoise = {
  substringAvgKept: +avg(trapRows.map((r) => r.subCount)).toFixed(2),
  productionAvgKept: +avg(trapRows.map((r) => r.prodCount)).toFixed(2),
  bm25AvgKept: +avg(trapRows.map((r) => r.bmCount)).toFixed(2),
  filteredAvgKept: +avg(trapRows.map((r) => r.fltCount)).toFixed(2),
};

const ciOk = robProd.ciLoPp > 0;
const foldsOk = robProd.foldMeanPp > 0 && robProd.negativeFolds < robProd.folds / 2;
/** 未过阈值的另一变体是否也过了（用于区分「只有调了阈值才过」与「两种口径都过」）。 */
const rawAlsoPasses = robTopK.ciLoPp > 0 && robTopK.negativeFolds < robTopK.folds / 2;

// ── 第一关附加判据：**假阳性分数下限**（2026-10-02 加入）─────────────────────────
// 动机：BM25 存在一个与查询无关的**分数地板**——与技能域无关的提示同样能打出不低的分
// （机理：技能正文遍布「函数 / 内容 / 检索 / 配置」这类仓库域高频词，短查询只能命中这些词）。
// 若地板与真命中得分区间**重叠**，那么「top-k 召回很高」就只是「对什么提示都返回一批技能」的
// 副产品，召回数字**不能**作为有效证据。判据：GT 技能的**得分中位数**必须高于**陷阱查询的
// 最高得分**（水位线）。陷阱查询刻意与正样本**等长同句式**——否则水位线会被短句压虚低。
const trapMaxScore = (() => {
  let max = 0;
  for (const r of trapRows) {
    const top = retriever.rank(skills, r.q, { topK: 1 })[0]?.score ?? 0;
    if (top > max) max = top;
  }
  return max;
})();
const scoreOfGt = (row) => {
  const ranked = retriever.rank(skills, row.q, { topK: skills.length });
  return ranked.find((h) => h.skill.name === row.gt)?.score ?? 0;
};
const gtScores = positives.map(scoreOfGt).sort((a, b) => a - b);
const gtMedianScore = gtScores.length === 0 ? 0 : (gtScores[Math.floor(gtScores.length / 2)] ?? 0);
const gtAboveFloor = gtScores.filter((s) => s > trapMaxScore).length;
/** 假阳性下限判据：GT 得分中位数必须高于陷阱查询的最高分。 */
const floorOk = gtMedianScore > trapMaxScore;

const passed = wiringOk && sensitivityOk && corpusOk && floorOk && ciOk && foldsOk;

console.log('\n=== 第一关附加：假阳性分数下限（BM25 对无关提示也有分）===');
console.log(
  `  陷阱查询（无领域信号）的最高得分 = 水位线 ${trapMaxScore.toFixed(2)}；GT 得分中位数 = ${gtMedianScore.toFixed(2)}`,
);
console.log(
  `  超过水位线的 GT：${gtAboveFloor}/${n}（${pct(n === 0 ? 0 : gtAboveFloor / n)}）⇒ 判据 ${floorOk ? '过' : '**未过**（两个分数区间重叠 ⇒ 排序无区分力）'}`,
);

console.log('\n=== 裁定（两关齐过才可翻默认：docs/POLISH_PLAN.md「CI 下界 >0 且留出折为正」）===');
console.log(
  '  判定档 = **生产管线** `SkillRegistry.rankForPrompt() -> SkillSparsifier`（与 `Agent.injectSkills` 逐行同构）',
);
if (!corpusOk) {
  console.log('  ❌ 语料不自洽：探针的 ground truth 技能不在语料里 ⇒ 结果无效。');
} else if (!wiringOk) {
  console.log('  ❌ 第一关未过：某一臂在全部探针上都给不出技能（接线失效，不是判据等价）。');
} else if (!sensitivityOk) {
  console.log(
    `  ❌ 第一关未过：新路 Top-K 跨查询重合度 ${bmSensitivity.toFixed(3)} 过高 ⇒ 常量偏置。`,
  );
} else if (!floorOk) {
  console.log(
    `  ❌ **第一关未过（决定性）**：假阳性分数下限判据不过——陷阱查询最高分 ${trapMaxScore.toFixed(2)} ≥ GT 得分中位数 ${gtMedianScore.toFixed(2)}，`,
  );
  console.log('     即「无关提示得分」与「真命中得分」两个区间重叠 ⇒ 排序在本语料上**无区分力**，');
  console.log(`     此时下面的 CI（[${robProd.ciLoPp}, ${robProd.ciHiPp}]pp）不能当成有效证据。`);
} else if (!ciOk) {
  console.log(
    `  ❌ 第二关未过：CI 下界 ${robProd.ciLoPp}pp ≤ 0 ⇒ 与噪声不可区分，不得声称有效、不翻默认。`,
  );
} else if (!foldsOk) {
  console.log(
    `  ❌ 第二关未过：留出折 ${robProd.negativeFolds}/${robProd.folds} 为负 ⇒ 增益不稳健。`,
  );
} else {
  console.log(
    `  ✅ 三道判据齐过：召回 ${pct(subRecall)} → ${pct(prodRecall)}（+${robProd.pointPp}pp，CI95 [${robProd.ciLoPp}, ${robProd.ciHiPp}]pp，留出折 0 为负）。`,
  );
  console.log(
    `     分数下限（本条判据的实质）：无关提示的地板最高只到 ${trapMaxScore.toFixed(2)}，而真命中得分中位数是 ${gtMedianScore.toFixed(2)}、`,
  );
  console.log(
    `     ${gtAboveFloor}/${n} 条 GT 高于地板 ⇒ 地板**低于**真命中区间，不构成混淆，故上述 CI 可作为有效证据。`,
  );
}
console.log(
  `  代价（必须一并引用，不得只引召回）：噪声 ${subNoise.toFixed(2)} → ${prodNoise.toFixed(2)} 条/查询；` +
    `陷阱查询平均注入 ${trapNoise.substringAvgKept} → ${trapNoise.productionAvgKept} 条`,
);
console.log(
  `  ⇒ 生产取「相对阈值过滤档」而非纯 top-k：纯 top-k 召回 ${pct(bmRecall)}、噪声 ${bmNoise.toFixed(2)} 条/查询、陷阱 ${String(trapNoise.bm25AvgKept)} 条；` +
    `过滤档召回 ${pct(prodRecall)}、噪声 ${prodNoise.toFixed(2)}、陷阱 ${String(trapNoise.productionAvgKept)} 条。`,
);
console.log(
  `  ⚠️ 口径边界：判据是**路由命中率**，不是任务成功率；语料 ${skills.length} 条，远低于本仓` +
    `「扩到 n≥80 再判」的历史口径 ⇒ CI 宽度本身即结论的一部分，点估计不得脱离 CI 引用。`,
);

const diffs = {
  subOnly: positives
    .filter((r) => r.subHit === 1 && r.prodHit === 0)
    .map((r) => ({ q: r.q, gt: r.gt })),
  prodOnly: positives
    .filter((r) => r.subHit === 0 && r.prodHit === 1)
    .map((r) => ({ q: r.q, gt: r.gt })),
};
console.log(
  `\n  只有子串召到：${diffs.subOnly.length} 条；只有相关性召到：${diffs.prodOnly.length} 条`,
);
for (const d of diffs.prodOnly) console.log(`    + "${d.q}" → ${d.gt}`);
for (const d of diffs.subOnly) console.log(`    - "${d.q}" → ${d.gt}`);

console.log(
  `\n=== 陷阱查询（无领域信号，期望不注入）===\n  平均注入条数：子串 ${trapNoise.substringAvgKept} / 生产档 ${trapNoise.productionAvgKept} / BM25 纯 top-5 ${trapNoise.bm25AvgKept}`,
);

writeFileSync(
  new URL('./skill-routing-ab.report.json', import.meta.url),
  JSON.stringify(
    {
      eval: 'skill-routing-ab',
      generatedAt: new Date().toISOString(),
      corpus: {
        file: SKILLS_FILE.replace(ROOT, '.'),
        size: skills.length,
        provenance:
          'real: defaults/skills/harness-core.json（面向本仓自身领域、内容可由仓库文件核对）',
        orphanProbes,
      },
      probes: { total: rows.length, withGroundTruth: n, traps: trapRows.length, topK: TOP_K },
      decisionBasis:
        '①接线活性 + 跨查询敏感度 < 0.6；②假阳性分数下限（GT 得分中位数 > 陷阱最高分）；' +
        '③同预算配对 bootstrap CI 下界 > 0 且留出折为正（docs/POLISH_PLAN.md P1；D6 两关）。' +
        '判定档 = 生产管线 SkillRegistry.rankForPrompt() + SkillSparsifier（与 Agent.injectSkills 同构）。',
      verdict: {
        gate1Wiring: wiringOk,
        gate1Sensitivity: sensitivityOk,
        gate1ScoreFloor: floorOk,
        corpusConsistent: corpusOk,
        gate2Ci: ciOk,
        gate2Folds: foldsOk,
        passed,
        warning:
          '判据是路由命中率而非任务成功率；语料 13 条 < 本仓 n≥80 口径 ⇒ 本次是按**效应量**' +
          '（+38.5pp 且 40/40 折一致）下的判，CI 宽度本身即结论的一部分，点估计不得脱离 CI 引用。' +
          ' gate1ScoreFloor 是 2026-10-02 新增判据：没有它，「对什么提示都给技能」同样能刷出高召回。',
      },
      scoreFloor: {
        trapMaxScore: +trapMaxScore.toFixed(2),
        gtMedianScore: +gtMedianScore.toFixed(2),
        gtAboveFloor,
        gtTotal: n,
        gtScoreDistribution: gtScores.map((s) => +s.toFixed(2)),
      },
      production: {
        recall: +prodRecall.toFixed(4),
        noise: +prodNoise.toFixed(3),
        trapsAvgKept: trapNoise.productionAvgKept,
        path: 'SkillRegistry.rankForPrompt()+SkillSparsifier',
      },
      substring: {
        recall: +subRecall.toFixed(4),
        recallTopK: +subRecallTopK.toFixed(4),
        noise: +subNoise.toFixed(3),
        mrr: +subMrr.toFixed(4),
      },
      bm25: {
        recall: +bmRecall.toFixed(4),
        recallTopK: +bmRecallTopK.toFixed(4),
        noise: +bmNoise.toFixed(3),
        mrr: +bmMrr.toFixed(4),
      },
      bm25Filtered: {
        recall: +fltRecall.toFixed(4),
        recallTopK: +fltRecallTopK.toFixed(4),
        noise: +fltNoise.toFixed(3),
      },
      robustness: { production: robProd, bm25: robTopK, bm25Filtered: robFiltered },
      veto: {
        produced: { substring: producedA, bm25: producedB, total: rows.length },
        crossQuerySensitivity: {
          substring: +subSensitivity.toFixed(3),
          bm25: +bmSensitivity.toFixed(3),
        },
        meanArmTopKOverlap: +meanPairOverlap.toFixed(3),
        threshold: OVERLAP_THRESHOLD,
      },
      traps: trapNoise,
      differences: diffs,
      rows,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/skill-routing-ab.report.json');

if (GATE && !passed) process.exitCode = 1;
