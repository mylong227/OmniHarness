// OmniHarness 效率与成本基准（可复现 · 零外部依赖 · 无需 API key）
// 跑法：node benchmark/efficiency_benchmark.mjs
//
// 设计动机（来自竞品调研的诚实缺口）：
//   冷启动 P50/P95、常驻内存、上下文压缩率、前缀缓存复用率 —— 这四项
//   **全行业无一家公布**，因此无法引用竞品数字，只能自测占位。
//   本脚本把这四项变成任何人都能复跑的机械测量，输出 JSON + Markdown。

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Bm25Index, tokenize } from '../dist/src/search/bm25.js';
import { DeterministicCompressor, PrefixStability } from '../dist/src/context/index.js';
import { Algebra } from '../dist/src/genesis/algebra.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const round = (x, d = 3) => Number(x.toFixed(d));
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx] ?? 0;
};

const results = {};

// ══════════ 1. 依赖与体积审计 ══════════
console.log('── 1. 依赖与体积审计 ──');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
const devDeps = Object.keys(pkg.devDependencies ?? {});
function dirSize(p) {
  try {
    const out = spawnSync('node', [
      '-e',
      `const{readdirSync,statSync}=require('fs');const{join}=require('path');
       let t=0;(function w(d){for(const e of readdirSync(d,{withFileTypes:true})){const f=join(d,e.name);
       try{if(e.isDirectory())w(f);else t+=statSync(f).size}catch{}}})(${JSON.stringify(p)});console.log(t)`,
    ]);
    return Number(out.stdout.toString().trim() || 0);
  } catch {
    return 0;
  }
}
const distBytes = dirSize(join(ROOT, 'dist'));
results.deps = {
  runtime: runtimeDeps.length,
  dev: devDeps.length,
  distMb: round(distBytes / 1048576, 2),
};
console.log(
  `  运行时依赖: ${runtimeDeps.length}   开发依赖: ${devDeps.length}   dist: ${results.deps.distMb} MB`,
);
console.log(
  `  → 竞品参照(调研实测): CrewAI 31 / Aider ~45 / LangGraph 6 / Codex 0(但含 238MB 平台包)\n`,
);

// ══════════ 2. 冷启动 P50/P95 ══════════
console.log('── 2. 冷启动延迟（CLI --help × 20） ──');
// 注意：顶层 `--help` 不被识别（status=2），必须用子命令形式 `exec --help`。
// 判据是「进程确实被启动执行」（status 非 null 且无 spawn error），
// 因为我们测的是启动延迟，而非退出码语义。
const COLD_N = 20;
const cold = [];
for (let i = 0; i < COLD_N; i += 1) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(ROOT, 'dist/src/cli/exec.js'), 'exec', '--help'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const t1 = process.hrtime.bigint();
  // 注意：spawnSync 成功时 r.error 是 undefined（不是 null），用 === null 判定会把全部样本滤掉。
  if (r.error === undefined && r.status !== null && r.signal === null) {
    cold.push(Number(t1 - t0) / 1e6);
  }
}
const coldSorted = cold.length > 0 ? cold : [0];
results.coldStart = {
  n: cold.length,
  p50Ms: round(pct(coldSorted, 50), 1),
  p95Ms: round(pct(coldSorted, 95), 1),
  minMs: round(Math.min(...coldSorted), 1),
};
console.log(
  `  P50=${results.coldStart.p50Ms}ms  P95=${results.coldStart.p95Ms}ms  min=${results.coldStart.minMs}ms (n=${cold.length})`,
);
console.log(`  → 行业空白：竞品均未公布启动延迟，无对照数字（诚实标注）\n`);

// ══════════ 3. 常驻内存基线 ══════════
console.log('── 3. 常驻内存基线（加载核心 index.js 后 RSS） ──');
const memProbe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const before=process.memoryUsage().rss;
     await import('file:///${join(ROOT, 'dist/src/index.js').replace(/\\/g, '/')}');
     global.gc?.();
     console.log(JSON.stringify({before, after: process.memoryUsage().rss}));`,
  ],
  { cwd: ROOT, encoding: 'utf8' },
);
let memMb = 0;
let memDeltaMb = 0;
try {
  const m = JSON.parse(memProbe.stdout.trim());
  memMb = round(m.after / 1048576, 1);
  memDeltaMb = round((m.after - m.before) / 1048576, 1);
} catch {
  /* 探针失败则记 0，不伪造 */
}
results.memory = { rssMb: memMb, loadDeltaMb: memDeltaMb };
console.log(`  加载后 RSS=${memMb} MB（核心模块增量 ${memDeltaMb} MB）`);
console.log(`  → 行业空白：竞品均未公布常驻内存基线\n`);

// ══════════ 4. 确定性上下文压缩率 ══════════
console.log('── 4. 确定性上下文压缩（零依赖，无模型） ──');
const logBlock = (n, tag) =>
  Array.from(
    { length: n },
    (_, i) =>
      `[${tag}] ${new Date(1700000000000 + i * 1000).toISOString()} INFO step=${i} payload=some tool output line ${i}`,
  ).join('\n');
const jsonBlock = JSON.stringify(
  {
    files: Array.from({ length: 40 }, (_, i) => ({
      path: `src/a${i}.ts`,
      lines: 100 + i,
      ok: true,
    })),
  },
  null,
  2,
);
const corpus = [
  { key: 'system', kind: 'system', text: 'You are OmniHarness.\n\n\n\n遵守零依赖铁律。   \n' },
  { key: 'tool-json', kind: 'tool-result', text: jsonBlock },
  { key: 'tool-log-1', kind: 'tool-result', text: logBlock(600, 'build') },
  { key: 'tool-log-2', kind: 'tool-result', text: logBlock(320, 'test') },
];
// 12 轮对话，含重复
for (let i = 1; i <= 6; i += 1) {
  corpus.push({ key: `u${i}`, kind: 'user', text: '读取 src/a1.ts 并解释第 3 行' });
  corpus.push({
    key: `a${i}`,
    kind: 'assistant',
    text: `已读取 src/a1.ts，第 3 行是导入语句。这是第 ${i} 轮。`,
  });
}
const { report: cr } = DeterministicCompressor.compressContext(corpus);
results.compression = {
  originalKb: round(cr.originalBytes / 1024, 2),
  compressedKb: round(cr.compressedBytes / 1024, 2),
  ratio: round(cr.ratio, 4),
  savedPct: round((1 - cr.ratio) * 100, 1),
  stages: cr.stages.map((s) => `${s.stage}:${s.savedBytes}`),
};
console.log(
  `  ${results.compression.originalKb} KB → ${results.compression.compressedKb} KB  省 ${results.compression.savedPct}%`,
);
console.log(`  分阶段: ${results.compression.stages.join('  ')}`);
console.log(`  → 生态位: LLMLingua 20× 需模型权重(零依赖下出局); 本方案纯算法、零幻觉、幂等可证\n`);

// ══════════ 5. 前缀缓存复用率 ══════════
console.log('── 5. 前缀复用率（决定上游 KV 缓存命中率） ──');
const segs = [
  { key: 'system', tier: 0, text: 'You are OmniHarness, a zero-dependency agent harness.' },
  { key: 'tools', tier: 1, text: 'read_file(path)\nwrite_file(path,content)\nlist_dir(path)' },
  { key: 'history', tier: 2, text: 'user: 读取 a.ts\nassistant: 已读取' },
  { key: 'input', tier: 3, text: '请修改 a.ts 第 3 行' },
];
const naiveJoin = (ss) => ss.map((s) => `\n## ${s.key}\n${s.text}`).join('');
const N_VAR = 20;
const canonicalRep = PrefixStability.measurePrefixStability(segs, N_VAR, true);
const rawRep = PrefixStability.measurePrefixStability(segs, N_VAR, false);
let naiveSum = 0;
const nBase = naiveJoin(PrefixStability.jitterSegments(segs, 1));
for (let i = 1; i <= N_VAR; i += 1)
  naiveSum += PrefixStability.prefixReuse(
    nBase,
    naiveJoin(PrefixStability.jitterSegments(segs, i)),
  );
const naiveMean = naiveSum / N_VAR;
results.prefix = {
  variants: N_VAR,
  canonicalMean: round(canonicalRep.meanReuse, 4),
  canonicalMin: round(canonicalRep.minReuse, 4),
  rawMean: round(rawRep.meanReuse, 4),
  naiveMean: round(naiveMean, 4),
};
console.log(`  朴素拼接(无序/未擦除): ${results.prefix.naiveMean}`);
console.log(`  仅排序(未擦易变片段)  : ${results.prefix.rawMean}`);
console.log(
  `  规范+擦除(本方案)     : ${results.prefix.canonicalMean} (min ${results.prefix.canonicalMin})`,
);
console.log(`  → 上游收益锚点(Anthropic 官方): 100k 缓存提示 TTFT −79%、成本 −90%\n`);

// ══════════ 6. 工具按需加载削减率 ══════════
console.log('── 6. 工具定义按需加载（真实工具集） ──');
const toolDir = join(ROOT, 'src/adapters/tool');
const tools = [];
for (const f of readdirSync(toolDir).filter((x) => x.endsWith('.ts'))) {
  const src = readFileSync(join(toolDir, f), 'utf8');
  for (const m of src.matchAll(/name:\s*'([a-z_0-9]+)'/g)) {
    const name = m[1];
    if (name && !tools.some((t) => t.name === name)) {
      const descMatch = src.match(
        new RegExp(`name:\\s*'${name}'[\\s\\S]{0,400}?description:\\s*'([^']{5,200})'`),
      );
      tools.push({ name, description: descMatch ? descMatch[1] : `${name} tool` });
    }
  }
}
const allToolsText = tools.map((t) => `${t.name}: ${t.description}`).join('\n');
const index = new Bm25Index();
index.addDocuments(tools.map((t) => tokenize(`${t.name} ${t.description}`)));
const QUERIES = [
  '读取文件内容',
  '写入文件',
  '搜索工具',
  '执行 shell 命令',
  '保存记忆',
  '检索记忆',
  '创建待办',
  '提交计划',
];
const TOP_K = 5;
let selBytes = 0;
let allBytes = DeterministicCompressor.byteLength(allToolsText);
for (const q of QUERIES) {
  const hits = index.search(tokenize(q), TOP_K);
  const sel = hits.map((h) => `${tools[h.id].name}: ${tools[h.id].description}`).join('\n');
  selBytes += DeterministicCompressor.byteLength(sel);
}
const avgSel = selBytes / QUERIES.length;
results.toolLoading = {
  toolCount: tools.length,
  allBytes,
  avgSelectedBytes: round(avgSel, 1),
  reductionPct: round((1 - avgSel / allBytes) * 100, 1),
  topK: TOP_K,
};
console.log(
  `  真实工具数: ${tools.length}   全量注入 ${allBytes} B → top-${TOP_K} 平均 ${round(avgSel, 1)} B`,
);
console.log(`  削减 ${results.toolLoading.reductionPct}%`);
console.log(`  → 收益锚点(Anthropic 实测): 工具定义从 ~77K tokens → ~8.7K(−85%)\n`);

// ══════════ 7. BM25 检索吞吐 ══════════
console.log('── 7. BM25 检索吞吐（零依赖倒排） ──');
const QN = 2000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < QN; i += 1) index.search(tokenize(QUERIES[i % QUERIES.length]), TOP_K);
const t1 = process.hrtime.bigint();
const elapsedMs = Number(t1 - t0) / 1e6;
results.retrieval = {
  queries: QN,
  totalMs: round(elapsedMs, 1),
  qps: round(QN / (elapsedMs / 1000), 0),
  avgUs: round((elapsedMs * 1000) / QN, 2),
};
console.log(
  `  ${QN} 次查询 / ${round(elapsedMs, 1)}ms → ${results.retrieval.qps} qps（平均 ${results.retrieval.avgUs}µs/次）\n`,
);

// ══════════ 8. Genesis 能耗代数开销 ══════════
console.log('── 8. Genesis 能耗代数吞吐（可证交换幺半群） ──');
const GN = 50000;
let acc = Algebra.cost(0);
const g0 = process.hrtime.bigint();
for (let i = 0; i < GN; i += 1) acc = Algebra.concatCost(acc, Algebra.cost(i % 7));
const g1 = process.hrtime.bigint();
const gMs = Number(g1 - g0) / 1e6;
results.genesisAlgebra = {
  ops: GN,
  totalMs: round(gMs, 1),
  opsPerSec: round(GN / (gMs / 1000), 0),
  avgNs: round((gMs * 1e6) / GN, 1),
  accTokens: acc.tokens,
};
console.log(
  `  ${GN} 次 Cost 合并 / ${round(gMs, 1)}ms → ${results.genesisAlgebra.opsPerSec} ops/s（${results.genesisAlgebra.avgNs} ns/次）`,
);
console.log(`  → 该开销相对单次 LLM 调用(10^8 ns 量级)可忽略，能耗账本零负担\n`);

// ══════════ 记分卡 ══════════
console.log('============================================================');
console.log(' 效率与成本记分卡（自测 · 行业空白列占位）');
console.log('============================================================');
const card = [
  ['维度', 'OmniHarness 实测', '竞品公开数字'],
  ['运行时依赖', `${results.deps.runtime} 个`, 'CrewAI 31 / Aider ~45 / LangGraph 6'],
  ['安装体积(dist)', `${results.deps.distMb} MB`, 'Codex 平台包 238MB / MetaGPT 镜像 ~3GB'],
  ['冷启动 P50', `${results.coldStart.p50Ms} ms`, '未公布（行业空白）'],
  ['冷启动 P95', `${results.coldStart.p95Ms} ms`, '未公布（行业空白）'],
  [
    '常驻 RSS',
    `${results.memory.rssMb} MB(含 Node 基线)`,
    `未公布；核心模块增量仅 ${results.memory.loadDeltaMb} MB`,
  ],
  ['上下文压缩', `省 ${results.compression.savedPct}%`, 'LLMLingua 20×(需模型权重)'],
  [
    '前缀复用率',
    `${results.prefix.canonicalMean}`,
    '未公布；朴素拼接实测 ' + results.prefix.naiveMean,
  ],
  ['工具按需加载', `省 ${results.toolLoading.reductionPct}%`, 'Anthropic 实测 −85%'],
  ['检索吞吐', `${results.retrieval.qps} qps`, '向量库需 embedding 模型'],
];
for (const r of card) console.log('  ' + r[0].padEnd(16) + '| ' + r[1].padEnd(22) + '| ' + r[2]);
console.log('\n诚实边界：竞品列凡标「未公布」者，均为调研未检索到公开数字，');
console.log('          不构成对比结论；本卡只呈事实，不宣称未实测的超越。');

const outPath = join(ROOT, 'benchmark/efficiency-benchmark.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`\nJSON 已落盘: ${outPath}`);
