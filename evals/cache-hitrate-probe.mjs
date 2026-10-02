#!/usr/bin/env node
// 缓存命中率**生产路径实测**（2026-10-02 补齐「有缓存、无度量」缺口后的验收脚本）。
//
// 为什么单列：埋点本身只证明「计数会动」，不证明「生产链路上真的命中」。本脚本走
// `RepoMapContextEngine`（组合根 `memoryStackAssembler` 用的同一构造、无参数差异），
// 对**真实仓库语料**重复查询，读出 `cacheStats()` —— 让「语料索引 / repo-map memo 到底命中多少」
// 第一次有可复核的数字，而不是靠猜。
//
// 用法：node evals/cache-hitrate-probe.mjs [重复次数，默认 6]
// 产物：evals/cache-hitrate-probe.report.json
// 免网络、免模型、免 API key。

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { RepoMapContextEngine } = await import(
  new URL('../dist/src/context/repoMap/repoMapContextEngine.js', import.meta.url).href
);

const REPEAT = Number(process.argv[2] ?? 6);
const corpusRoot = join(ROOT, 'src');
const engine = new RepoMapContextEngine();

const Q1 = 'where is the workspace index reused across steps';
const Q2 = 'how is a tool result spilled out of context';

const started = Date.now();
for (let i = 0; i < REPEAT; i += 1) {
  engine.getRepoMapContext(corpusRoot, Q1);
}
const afterRepeat = engine.cacheStats();
engine.getRepoMapContext(corpusRoot, Q2);
const afterSwitch = engine.cacheStats();
const elapsedMs = Date.now() - started;

const pct = (r) => `${(r * 100).toFixed(1)}%`;
console.log(`语料根：${corpusRoot}`);
console.log(`重复同一查询 ${REPEAT} 次，再换一条查询 1 次（共 ${REPEAT + 1} 次）\n`);

console.log('=== 缓存命中率（生产入口 RepoMapContextEngine）===');
for (const [name, s] of Object.entries(afterSwitch)) {
  console.log(
    `  ${name.padEnd(22)} 命中 ${String(s.hits).padStart(3)} / 未命中 ${String(s.misses).padStart(3)}  命中率 ${pct(s.hitRate).padStart(6)}`,
  );
}

const corpusAfterRepeat = afterRepeat['CorpusIndexCache'];
const memoAfterRepeat = afterRepeat['RepoMapMemo'];
console.log('\n=== 构造性断言（不依赖统计推断）===');
const checks = [
  [
    `重复查询阶段 corpusCache 未命中恰好 1 次（首次索引）`,
    corpusAfterRepeat !== undefined && corpusAfterRepeat.misses === 1,
    `实得 misses=${String(corpusAfterRepeat?.misses)}`,
  ],
  [
    `重复查询阶段 corpusCache 命中 ${REPEAT - 1} 次（TTL 内复用）`,
    corpusAfterRepeat !== undefined && corpusAfterRepeat.hits === REPEAT - 1,
    `实得 hits=${String(corpusAfterRepeat?.hits)}`,
  ],
  [
    `重复查询阶段 memo 命中 ${REPEAT - 1} 次（同查询同语料）`,
    memoAfterRepeat !== undefined && memoAfterRepeat.hits === REPEAT - 1,
    `实得 hits=${String(memoAfterRepeat?.hits)}`,
  ],
  [
    `换查询后 memo 未命中 +1（查询文本进 key）`,
    (afterSwitch['RepoMapMemo']?.misses ?? 0) === (memoAfterRepeat?.misses ?? 0) + 1,
    `实得 ${String(afterSwitch['RepoMapMemo']?.misses)} vs ${String((memoAfterRepeat?.misses ?? 0) + 1)}`,
  ],
  [
    `换查询后 corpusCache 未新增未命中（语料未变，仍复用）`,
    (afterSwitch['CorpusIndexCache']?.misses ?? 0) === (corpusAfterRepeat?.misses ?? 0),
    `实得 misses=${String(afterSwitch['CorpusIndexCache']?.misses)}`,
  ],
];

let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}  （${detail}）`);
  if (ok !== true) failed += 1;
}

writeFileSync(
  new URL('./cache-hitrate-probe.report.json', import.meta.url),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      corpusRoot,
      repeat: REPEAT,
      elapsedMs,
      afterRepeat,
      afterSwitch,
      checks: checks.map(([label, ok, detail]) => ({ label, ok, detail })),
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/cache-hitrate-probe.report.json');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项构造性断言失败`);
  process.exit(1);
}
console.log(`\n✅ 全部构造性断言通过（耗时 ${elapsedMs}ms）`);
