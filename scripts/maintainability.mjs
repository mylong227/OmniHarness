#!/usr/bin/env node
// 可维护性预算审计（零依赖）。
//
// 用途：把 docs/MAINTAINABILITY_PLAN_2026-11.md §1 的预算表变成可复核的读数。
// 每项都输出「当前值 / 预算 / 状态」，任一项超标即非零退出（可接进 runGates）。
//
// 用法：
//   node scripts/maintainability.mjs                 # 全表 + 超标即 exit 1
//   node scripts/maintainability.mjs --json          # 机器可读
//   node scripts/maintainability.mjs --no-fail       # 只看读数，不判失败
//   node scripts/maintainability.mjs --budget <file> # 换预算文件
//
// 纪律：本脚本只读仓库，不写入、不联网。数字口径写死在下方各 measure 函数里，
// 改口径必须同时改预算文件与文档，否则读数会悄悄漂移。

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', '.cache', '.coverage']);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const noFail = args.includes('--no-fail');
const budgetFlag = args.indexOf('--budget');
const budgetPath =
  budgetFlag >= 0 ? args[budgetFlag + 1] : join(ROOT, 'maintainability.budget.json');

/** 递归收集文件（按扩展名过滤），跳过构建产物与依赖目录。 */
async function walk(dir, ext, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(p, ext, out);
    } else if (e.name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

async function countLines(file) {
  const text = await readFile(file, 'utf8');
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** src 总行数 / 文件数 / 模块（src 下的一级目录）行数。 */
async function measureSrc() {
  const files = await walk(join(ROOT, 'src'), '.ts');
  let total = 0;
  const perFile = new Map();
  for (const f of files) {
    const n = await countLines(f);
    total += n;
    perFile.set(f, n);
  }
  const modules = new Map();
  for (const [f, n] of perFile) {
    const rel = relative(join(ROOT, 'src'), f).split(sep);
    const mod = rel.length > 1 ? rel[0] : '(root)';
    modules.set(mod, (modules.get(mod) ?? 0) + n);
  }
  return { files: files.length, total, modules, perFile };
}

/** 公开面：两个桶里的 export 语句数（粗口径：以行首 export 计，重导出与声明都算）。 */
async function countExports(file) {
  if (!existsSync(file)) return 0;
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter((l) => /^export\s/.test(l.trim())).length;
}

async function measurePackage() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return {
    version: pkg.version,
    scripts: Object.keys(pkg.scripts ?? {}).length,
    runtimeDeps: Object.keys(pkg.dependencies ?? {}).length,
  };
}

/** 模块 README：src 下一级目录里是否有 README.md。 */
async function measureModuleReadmes(modules) {
  const names = [...modules.keys()].filter((m) => m !== '(root)');
  const missing = [];
  for (const m of names) {
    if (!existsSync(join(ROOT, 'src', m, 'README.md'))) missing.push(m);
  }
  return { total: names.length, missing };
}

/** 版本一致性：包版本必须出现在 API_STABILITY.md 里（契约文档与包版本的口径锚）。 */
async function measureVersionConsistency(pkgVersion) {
  const docPath = join(ROOT, 'docs', 'API_STABILITY.md');
  const versionTs = join(ROOT, 'src', 'version.ts');
  if (!existsSync(docPath) || !existsSync(versionTs)) {
    return { ok: false, reason: 'API_STABILITY.md 或 src/version.ts 缺失' };
  }
  const doc = await readFile(docPath, 'utf8');
  const vt = await readFile(versionTs, 'utf8');
  const apiVersion = /API_VERSION\s*=\s*'([^']+)'/.exec(vt)?.[1] ?? '?';
  // 规则（2026-11-02）：文档**不应**硬编码包版本；一旦硬编码，就必须等于当前 package.json 的值。
  // 这样升级包版本时，要么没写（无漂移），要么写错即红。
  const hardcoded = [...doc.matchAll(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/g)].map((m) => m[1]);
  const stale = hardcoded.filter((v) => v !== pkgVersion);
  return {
    ok: stale.length === 0,
    apiVersion,
    packageVersion: pkgVersion,
    reason:
      stale.length === 0
        ? hardcoded.length === 0
          ? '文档不硬编码包版本（好）'
          : `文档硬编码的包版本与 package.json 一致`
        : `API_STABILITY.md 硬编码了过期包版本 ${stale.join(', ')}（当前 ${pkgVersion}）`,
  };
}

async function measureDocs() {
  const dir = join(ROOT, 'docs');
  const entries = await readdir(dir, { withFileTypes: true });
  const md = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  return {
    md: md.length,
    adr: existsSync(join(dir, 'adr')) ? (await readdir(join(dir, 'adr'))).length : 0,
  };
}

function row(label, current, budget, ok, note = '') {
  return { label, current, budget, ok, note };
}

async function main() {
  const budget = JSON.parse(await readFile(budgetPath, 'utf8'));
  const src = await measureSrc();
  const pkg = await measurePackage();
  const docs = await measureDocs();
  const readmes = await measureModuleReadmes(src.modules);
  const version = await measureVersionConsistency(pkg.version);

  const publicExports = await countExports(join(ROOT, 'src', 'index.ts'));
  const betaExports = await countExports(join(ROOT, 'src', 'indexBeta.ts'));
  const biggestModule = [...src.modules.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['-', 0];
  const biggestFile = [...src.perFile.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['-', 0];
  const oversizeFiles = [...src.perFile.entries()].filter(([, n]) => n > budget.fileLines).length;

  const rows = [
    row('src 总行数', src.total, budget.srcLines, src.total <= budget.srcLines),
    row(
      '最大模块',
      biggestModule[1],
      budget.moduleLines,
      biggestModule[1] <= budget.moduleLines,
      biggestModule[0],
    ),
    row(
      `超过 ${budget.fileLines} 行的文件`,
      oversizeFiles,
      `≤${budget.oversizeBaseline}（棘轮）`,
      oversizeFiles <= budget.oversizeBaseline,
      `最大 ${biggestFile[1]} 行（${relative(ROOT, biggestFile[0])}）`,
    ),
    row(
      '@public 导出（index.ts）',
      publicExports,
      budget.publicExports,
      publicExports <= budget.publicExports,
    ),
    row(
      '@beta 导出（indexBeta.ts）',
      betaExports,
      budget.betaExports,
      betaExports <= budget.betaExports,
    ),
    row('npm scripts', pkg.scripts, budget.npmScripts, pkg.scripts <= budget.npmScripts),
    row(
      'docs 根 md',
      docs.md,
      budget.docsRootMd,
      docs.md <= budget.docsRootMd,
      `另 ADR ${docs.adr} 份`,
    ),
    row(
      '模块 README',
      `${readmes.total - readmes.missing.length}/${readmes.total}`,
      `${readmes.total}/${readmes.total}`,
      readmes.missing.length === 0,
      readmes.missing.slice(0, 6).join(' '),
    ),
    row(
      '版本口径一致',
      version.ok ? '一致' : '不一致',
      '一致',
      version.ok,
      version.reason || `API ${version.apiVersion} / 包 ${version.packageVersion}`,
    ),
    row('运行时依赖', pkg.runtimeDeps, 12, pkg.runtimeDeps <= 12),
  ];

  const failed = rows.filter((r) => !r.ok);

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ rows, failed: failed.length, budget, version }, null, 2) + '\n',
    );
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    process.stdout.write(`\n可维护性预算审计（预算文件：${relative(ROOT, budgetPath)}）\n\n`);
    process.stdout.write(
      `${pad('维度', 26)}${pad('当前', 14)}${pad('预算', 12)}${pad('状态', 6)}备注\n`,
    );
    process.stdout.write(`${'-'.repeat(78)}\n`);
    for (const r of rows) {
      process.stdout.write(
        `${pad(r.label, 26)}${pad(r.current, 14)}${pad(r.budget, 12)}${pad(r.ok ? '✓' : '✗', 6)}${r.note}\n`,
      );
    }
    process.stdout.write(
      `\n${failed.length === 0 ? '✓ 全部在预算内' : `✗ ${failed.length} 项超标`}\n\n`,
    );
  }

  if (failed.length > 0 && !noFail) process.exitCode = 1;
}

await main();
