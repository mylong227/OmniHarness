#!/usr/bin/env node
/**
 * 死模块门禁（无第三方依赖）——把「从生产入口不可达的源文件」从人工盘点变成机械事实。
 *
 * ## 为什么需要它（PLAN_2026-11.md P5 的判据化前置）
 *
 * P5 要做「减法审计：列出无生产调用方的模块 → 删除或移入 archive」。「无调用方」靠
 * 人记与一次性 grep 的结果必然漂移：今天删掉的模块明天可能又长出没人 import 的新文件，
 * 而没有任何门禁会报错。故先立门禁：**以生产入口为根做 import 图可达性分析，不可达 =
 * 死模块候选——存量冻结、新增即红**（与 `scripts/docLinkCheck.mjs` 同一纪律：新增阻断，
 * 存量按批清偿，每清一批 `--update` 收紧基线）。
 *
 * ## 口径
 *
 * - 扫描面：src 树下全部 .ts（排除 .d.ts）；相对导入（`./` `../`）解析为文件
 *   （精确 → `+.ts` → `/index.ts`）；`node:` 与包名导入不参与图；
 * - 图边：静态 `from '...'`（含 `export ... from` / `import type`）、动态 `import('...')`、
 *   副作用 `import '...'`；
 * - 入口根：`package.json` 的 bin 指向的编译产物所对应的**源文件**
 *   （`dist/src/apps/cli/exec.js` → `src/apps/cli/exec.ts`；`dist/bin/audit.mjs` 的源是
 *   `src/apps/cli/auditBin.ts`——由 `scripts/buildAuditBin.mjs` 打包，路径不可推导故显式列出）。
 *   **新增 bin / 打包入口时必须同步改这里的 ROOTS**，否则新入口的依赖树会被误判为死；
 * - 已知盲区：**运行时按路径加载**的文件（worker_threads / spawn 的字符串路径）不会出现在
 *   import 图里——它们会表现为"死"。若新增死候选确属此类，说明理由后 `--update` 纳入基线
 *   （基线是「已知非死」的显式备案，不是删除授权；真正删除仍走 P5 的调用方证据表）。
 *
 * ## 用法
 *
 *   node scripts/deadCode.mjs              # 检查（新增死模块则 exit 1）
 *   node scripts/deadCode.mjs --list       # 打印全部死模块（含存量）
 *   node scripts/deadCode.mjs --update     # 用当前结果重写基线（清偿后手动调用）
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'deadCodeBaseline.json');
const SRC = join(ROOT, 'src');
const args = process.argv.slice(2);

/**
 * 生产入口（源文件形态）——从 package.json **机械推导**（单一事实源）：
 * `main` + `exports[*].default` + `bin[*]` 的 `dist/src/X.js` 映射回 `src/X.ts`；
 * `dist/bin/audit.mjs` 的源由 `scripts/buildAuditBin.mjs` 打包（路径不可推导）故显式补上。
 * 新增 bin / 打包入口时同步维护——见文件头「口径」。
 */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const distTargets = [
  pkg.main,
  ...Object.values(pkg.exports ?? {}).map((entry) => entry?.default),
  ...Object.values(pkg.bin ?? {}),
]
  .filter((value) => typeof value === 'string')
  .map((value) => value.replace(/^\.\//, ''));
const ROOTS = [
  ...new Set(
    distTargets
      .filter((value) => value.startsWith('dist/src/'))
      .map((value) => value.replace(/^dist\/src\//, 'src/').replace(/\.js$/, '.ts')),
  ),
  'src/apps/cli/auditBin.ts',
];

/** 收集 src 树下全部 .ts 源文件（排除 .d.ts），返回仓库相对路径（正斜杠）。 */
function collectSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * 抽出一个源文件的全部**仓库内**导入目标（相对导入解析到文件；解析不到的不计边）。
 * @param repoPath 仓库相对路径（正斜杠）。
 * @returns 仓库相对路径数组（去重）。
 */
function importsOf(repoPath) {
  const text = readFileSync(join(ROOT, repoPath), 'utf8');
  const specifiers = [];
  for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
  const resolved = new Set();
  for (const spec of specifiers) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    const base = resolve(dirname(join(ROOT, repoPath)), spec);
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
      const rel = relative(ROOT, candidate).split(sep).join('/');
      if (rel.startsWith('src/') && rel.endsWith('.ts') && existsSync(candidate)) {
        resolved.add(rel);
        break;
      }
    }
  }
  return [...resolved];
}

/**
 * 从入口根做 BFS，返回可达集合。
 * @param graph 邻接表（repoPath → 导入目标）。
 * @returns 可达的仓库相对路径集合。
 */
function reachableFrom(graph) {
  const seen = new Set();
  const queue = [];
  for (const root of ROOTS) {
    if (graph.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of graph.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const allFiles = collectSources(SRC);
if (allFiles.length === 0) {
  console.error('✗ src 树没扫到任何 .ts 文件：扫描范围塌缩，按失败处理（不等于"零死模块"）。');
  process.exit(1);
}
for (const root of ROOTS) {
  if (!existsSync(join(ROOT, root))) {
    console.error(`✗ 生产入口缺失：${root}（bin/打包入口对应的源文件不存在）。`);
    process.exit(1);
  }
}
const graph = new Map(allFiles.map((file) => [file, importsOf(file)]));
const reachable = reachableFrom(graph);
const dead = allFiles.filter((file) => !reachable.has(file)).sort();

if (args.includes('--list')) {
  console.log(
    `扫描 ${String(allFiles.length)} 个源文件（入口 ${String(ROOTS.length)} 个）｜ ` +
      `可达 ${String(reachable.size)} ｜ 死模块候选 ${String(dead.length)} 个：`,
  );
  for (const file of dead) console.log(`  ${file}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')))
  : new Set();
const added = dead.filter((file) => !baseline.has(file));
const cleared = [...baseline].filter((file) => !dead.includes(file));

if (args.includes('--update')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(dead, null, 2)}\n`, 'utf8');
  console.log(
    `已写入基线：${relative(ROOT, BASELINE_PATH)}（${String(dead.length)} 个死模块候选 / 清偿 ${String(cleared.length)}）`,
  );
  process.exit(0);
}

console.log(
  `[deadCode] 扫描 ${String(allFiles.length)} 个源文件 ｜ 死模块候选 ${String(dead.length)} 个` +
    `（基线 ${String(baseline.size)} ｜ 新增 ${String(added.length)} ｜ 已清偿 ${String(cleared.length)}）`,
);
if (cleared.length > 0) {
  console.log('  已清偿（请运行 --update 收紧基线）：');
  for (const file of cleared) console.log(`    ${file}`);
}
if (added.length > 0) {
  console.error('✗ 新增死模块（从生产入口不可达）：');
  for (const file of added) console.error(`    ${file}`);
  console.error(
    '  接上调用方，或删除；确属运行时按路径加载等真实使用时，说明理由后运行 --update 纳入基线。',
  );
  process.exit(1);
}
console.log('✓ 无新增死模块');
