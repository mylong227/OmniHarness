#!/usr/bin/env node
// 跨仓库语料的**锚点候选探针**（语料扩充的常备仪器，2026-09-27）。
//
// 用途：为外部仓库（`eval-data/repos/*`）按本仓采集协议挑选检索评测锚点。
// 协议要求锚点「出现文件数 ≤ 3」（过泛锚点会把 GT 摊大、命中率被抬成噪声，见
// TASK_BOARD §24.2），故本工具机械列出每个语料里满足该约束的标识符候选，
// 按可读性启发式排序，供查询作者挑选；查询文本仍由人撰写并经
// `evals/recall-crossrepo.mjs` 的协议校验（避开锚点子词 / 不含 GT 路径词）。
// 语料根 = 各仓库的**可导入包源码目录**（与本仓「只索引 src/」同一口径，不含测试/文档），
// 清单取自 `tests/fixtures/recallQueriesCrossRepo.ts`（单一真相来源）。
//
// ⚠ 语料目录 `eval-data/` 整目录不入库（.gitignore）⇒ 本仪器只在语料就位的机器上有意义，
// 不纳入 CI 门禁（结构类不变量另见 `tests/unit/recallQueriesCrossRepo.test.ts`，那份零语料依赖）。
//
// 用法：node evals/crossrepo-anchor-probe.mjs [每仓输出条数=40]

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
// 语料清单**只存在于 fixture**（单一真相来源）：探针 / 词法仪器 / 语义仪器三处共用同一份，
// 免得「扩语料时改了 A 忘了 B」。`tests/unit/recallQueriesCrossRepo.test.ts` 第 ④ 条对着这点把关
// （仪器必须读 fixture，且不得再硬编码 `eval-data/repos/`）。
const { CROSS_REPO_CORPORA } = await import(
  pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueriesCrossRepo.js')).href
);

const LIMIT = Number(process.argv[2] ?? 40);

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].split('\\').join('/')}`).href;

if (isMain) {
  for (const { repo, root } of CROSS_REPO_CORPORA) {
    const abs = join(ROOT, root);
    const corpus = ContextEngine.indexCorpus(abs, { morph: true, light: true });
    console.log(
      `\n=== ${repo}  (${corpus.files.length} files / ${corpus.symbols.length} symbols) ===`,
    );
    // 标识符出现文件数：长度 ≥ 6 的 `[A-Za-z_][A-Za-z0-9_]*`，全词匹配。
    const filesOf = new Map();
    const ident = /[A-Za-z_][A-Za-z0-9_]{5,}/g;
    for (const [rel, text] of corpus.fileText) {
      const seen = new Set();
      for (const m of String(text).matchAll(ident)) seen.add(m[0]);
      for (const id of seen) {
        if (!filesOf.has(id)) filesOf.set(id, []);
        filesOf.get(id).push(rel);
      }
    }
    const candidates = [];
    for (const [id, files] of filesOf) {
      if (files.length < 1 || files.length > 3) continue;
      if (id.length < 6) continue;
      // 可读性启发：含大写驼峰或下划线复合词（信息量更高的名字），剔除纯小写常见词。
      if (!/[A-Z]/.test(id) && !id.includes('_')) continue;
      candidates.push({ id, files: files.length });
    }
    candidates.sort((a, b) => b.id.length - a.id.length);
    for (const c of candidates.slice(0, LIMIT)) console.log(`  ${c.files}  ${c.id}`);
  }
}
