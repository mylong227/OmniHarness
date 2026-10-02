#!/usr/bin/env node
// 技能路由对照评测：子串包含（生产默认）vs BM25 相关性检索（新增，opt-in）。
//
// ## 为什么要先做对照而不是直接改默认
//
// `SkillRegistry.match()` 的判据是 `text.includes(技能名或 tag)`。它在**同义改写**上必然漏召
// （用户说「把这个流程跑起来」，技能叫 `workflow-automation`），在**短 tag** 上又会误召
// （`test` / `plan` / `api` 这类词在无关文本里满地都是）。而本仓已记录的结论是
// 「技能堆叠引噪声」——所以「换更聪明的路由」既可能增收也可能增噪，**必须实测**。
//
// ## 样本诚实声明
//
// 本仓**没有内置技能**（技能全部来自配置 `OmniHarnessConfig.skills`），因此本评测用的是
// **合成技能集**（20 个技能 + 26 条查询）。它能回答「判据在同义改写上的行为差异」，
// **不能**当作本仓端到端收益的证据——后者需要真实技能库与任务成功率数据。
//
// 用法：node evals/skill-routing-ab.mjs
// 产物：evals/skill-routing-ab.report.json
// 免网络、免模型、免 API key、秒级。

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const { SkillRegistry } = await import(
  new URL('../dist/src/skill/skillRegistry.js', import.meta.url).href
);
const { SkillRetriever } = await import(
  new URL('../dist/src/skill/skillRetriever.js', import.meta.url).href
);

/** 合成技能集（模拟真实技能库：名字 + 标签 + 指令正文）。 */
const CATALOG = [
  [
    'workflow-automation',
    ['automation', 'pipeline'],
    'Chain several steps into a repeatable pipeline and run them unattended on a schedule.',
  ],
  [
    'code-review',
    ['review', 'quality'],
    'Inspect a diff for defects, style drift and missing test coverage.',
  ],
  [
    'incident-triage',
    ['incident', 'oncall'],
    'Classify an outage, find the blast radius and page the right owner.',
  ],
  [
    'sql-optimization',
    ['sql', 'database'],
    'Rewrite slow queries, avoid full scans and add the missing indexes.',
  ],
  [
    'refactor-extraction',
    ['refactor', 'cleanup'],
    'Split an oversized class or file into smaller cohesive pieces.',
  ],
  [
    'test-generation',
    ['test', 'coverage'],
    'Write unit tests for a module and raise coverage on the weak spots.',
  ],
  [
    'doc-writing',
    ['docs', 'documentation'],
    'Write a readme or usage guide that a newcomer can follow.',
  ],
  [
    'dependency-upgrade',
    ['deps', 'upgrade'],
    'Bump third party libraries to newer versions and fix the fallout.',
  ],
  [
    'security-audit',
    ['security', 'audit'],
    'Look for injection holes, unsafe defaults and missing validation.',
  ],
  [
    'perf-profiling',
    ['performance', 'profiling'],
    'Profile a slow endpoint and locate the hot path.',
  ],
  [
    'migration-planning',
    ['migration', 'plan'],
    'Plan a move off a legacy database or framework in safe stages.',
  ],
  ['api-design', ['api', 'design'], 'Choose the request and response shape for a new endpoint.'],
  [
    'ui-polish',
    ['ui', 'frontend'],
    'Fix spacing, alignment and responsive behaviour in the interface.',
  ],
  ['git-hygiene', ['git', 'history'], 'Squash, rebase and clean up commit history before merging.'],
  [
    'config-management',
    ['config', 'settings'],
    'Decide where a setting should live and how it is overridden.',
  ],
  [
    'error-handling',
    ['errors', 'resilience'],
    'Stop swallowing exceptions and make failures explicit and recoverable.',
  ],
  [
    'logging-instrumentation',
    ['logging', 'telemetry'],
    'Add tracing and structured logs so we can see what happened.',
  ],
  [
    'data-validation',
    ['validation', 'schema'],
    'Validate an incoming payload against an explicit schema.',
  ],
  [
    'release-process',
    ['release', 'deploy'],
    'Cut a release, tag it and roll it out to production safely.',
  ],
  [
    'onboarding-guide',
    ['onboarding', 'tutorial'],
    'Help a new teammate get the project running on their machine.',
  ],
];

/** 探针：查询文本 → 期望技能。措辞刻意**避开**技能名字面（同义改写），以考察真实路由能力。 */
const PROBES = [
  ['make this multi step flow run by itself on a schedule', 'workflow-automation'],
  ['chain several commands into a repeatable pipeline', 'workflow-automation'],
  ['inspect the diff for defects and missing coverage', 'code-review'],
  ['look over my changes for style drift', 'code-review'],
  ['classify this outage and page the right owner', 'incident-triage'],
  ['the service is down, figure out the blast radius', 'incident-triage'],
  ['this query is too slow, add the missing index', 'sql-optimization'],
  ['stop the database from scanning every row', 'sql-optimization'],
  ['split this oversized class into smaller pieces', 'refactor-extraction'],
  ['this file has grown too big, clean it up', 'refactor-extraction'],
  ['write unit tests for the new module', 'test-generation'],
  ['coverage is too low on this package', 'test-generation'],
  ['write the readme for this project', 'doc-writing'],
  ['bump our libraries to the latest versions', 'dependency-upgrade'],
  ['check for injection holes in this service', 'security-audit'],
  ['find out why this endpoint takes two seconds', 'perf-profiling'],
  ['we need to move off the old database in safe stages', 'migration-planning'],
  ['choose the request shape for this endpoint', 'api-design'],
  ['make the buttons line up properly', 'ui-polish'],
  ['clean up the commit history before merging', 'git-hygiene'],
  ['where should this setting live and how is it overridden', 'config-management'],
  ['we swallow exceptions everywhere, make failures explicit', 'error-handling'],
  ['add tracing so we can see what happened', 'logging-instrumentation'],
  ['check the incoming payload against an explicit schema', 'data-validation'],
  ['cut a version and roll it out to production safely', 'release-process'],
  ['help a new teammate get the project running locally', 'onboarding-guide'],
];

const registry = new SkillRegistry();
for (const [name, tags, instructions] of CATALOG) {
  registry.register({ name, description: instructions, tags, instructions });
}
const skills = registry.list();
const retriever = new SkillRetriever();

const pct = (r) => `${(r * 100).toFixed(1)}%`;
const rows = [];
for (const [q, gt] of PROBES) {
  const sub = registry.match(q);
  const subHit = sub.some((s) => s.name === gt);
  const ranked = retriever.rank(skills, q, { topK: 5 });
  const idx = ranked.findIndex((h) => h.skill.name === gt);
  const bmHit = idx >= 0;
  // 噪声控制变体：只保留得分 ≥ 最高分一半的（「宁可少给」在技能场景同样成立——堆叠即噪声）。
  const topScore = ranked[0]?.score ?? 0;
  const filtered = retriever.rank(skills, q, { topK: 5, minScore: topScore * 0.5 });
  const fIdx = filtered.findIndex((h) => h.skill.name === gt);
  rows.push({
    q,
    gt,
    subHit: subHit ? 1 : 0,
    subCount: sub.length,
    bmHit: bmHit ? 1 : 0,
    bmRank: idx >= 0 ? idx + 1 : null,
    bmCount: ranked.length,
    fltHit: fIdx >= 0 ? 1 : 0,
    fltCount: filtered.length,
  });
}

const n = rows.length;
const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const subRecall = sum((r) => r.subHit) / n;
const bmRecall = sum((r) => r.bmHit) / n;
const subNoise = sum((r) => Math.max(0, r.subCount - r.subHit)) / n;
const bmNoise = sum((r) => Math.max(0, r.bmCount - r.bmHit)) / n;
const fltRecall = sum((r) => r.fltHit) / n;
const fltNoise = sum((r) => Math.max(0, r.fltCount - r.fltHit)) / n;
const mrr = sum((r) => (r.bmRank === null ? 0 : 1 / r.bmRank)) / n;

console.log(`技能集：${CATALOG.length} 个（合成）｜探针：${n} 条（措辞刻意避开技能名字面）\n`);
console.log('=== 召回（GT 是否被路由到）===');
console.log(`  子串包含 match()        ${pct(subRecall)}`);
console.log(`  BM25 SkillRetriever     ${pct(bmRecall)}   MRR ${mrr.toFixed(3)}`);
console.log(`  BM25 + 半高阈值过滤     ${pct(fltRecall)}`);
console.log('\n=== 噪声（平均多带回多少条无关技能）===');
console.log(`  子串包含 match()        ${subNoise.toFixed(2)} 条/查询`);
console.log(`  BM25 SkillRetriever     ${bmNoise.toFixed(2)} 条/查询`);
console.log(`  BM25 + 半高阈值过滤     ${fltNoise.toFixed(2)} 条/查询`);

const subOnly = rows.filter((r) => r.subHit === 1 && r.bmHit === 0);
const bmOnly = rows.filter((r) => r.subHit === 0 && r.bmHit === 1);
console.log(`\n=== 差异明细 ===`);
console.log(`  只有子串召到：${subOnly.length} 条`);
for (const r of subOnly) console.log(`    - "${r.q}" → ${r.gt}`);
console.log(`  只有 BM25 召到：${bmOnly.length} 条`);
for (const r of bmOnly) console.log(`    - "${r.q}" → ${r.gt}`);

console.log(`\n=== 裁定 ===`);
console.log(
  `  BM25 在「同义改写」上召回 ${pct(bmRecall)} vs 子串 ${pct(subRecall)}，` +
    `噪声 ${bmNoise.toFixed(2)} vs ${subNoise.toFixed(2)} 条/查询。`,
);
console.log(
  `  ⇒ SkillRetriever 以 **opt-in** 落地（新增类、零行为变更）；` +
    `默认路径仍是 match()，因为本仓无内置技能、缺端到端证据，改默认属未经证明的行为变更。`,
);

writeFileSync(
  new URL('./skill-routing-ab.report.json', import.meta.url),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      catalogSize: CATALOG.length,
      probes: n,
      substring: { recall: +subRecall.toFixed(4), noise: +subNoise.toFixed(3) },
      bm25: { recall: +bmRecall.toFixed(4), noise: +bmNoise.toFixed(3), mrr: +mrr.toFixed(4) },
      bm25Filtered: { recall: +fltRecall.toFixed(4), noise: +fltNoise.toFixed(3) },
      rows,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/skill-routing-ab.report.json');
