#!/usr/bin/env node
/**
 * 门禁：**非 UI 的 .ts 生产代码里禁止顶层 `function` 声明**（一律用 `export class` + 静态/实例方法）。
 *
 * ## 为什么要有它（2026-09-26 用户口径 + 一次性清偿）
 *
 * 用户口径：**非前端 React UI 页面的 .ts 文件里，不得再出现 `export function xxx()` 或 `function xxx()`
 * 的实现方式，全部以 `export class` 实现**。存量 309 个（104 文件）已一次性改造完毕；
 * 没有机器门禁就会慢慢长回来，故把口径钉成判据。
 *
 * ## 范围（可执行、可解释）
 *
 * - **纳入**：`src/**\/*.ts`（生产代码；不含 `.d.ts`），且**必须在 git 索引里**（见下「只审代码库」）。
 * - **排除**：`web/src/ui/**`（React UI 页面，按用户口径排除）、`tests/**`（测试辅助函数，用户明确
 *   不在范围内）、`evals/`、`benchmark/`、`scripts/`（.mjs 工具脚本，不是产品实现）。
 *
 * ## 只审「代码库」，不审草稿（2026-09-27 修）
 *
 * 原先按盘上文件全量扫描 ⇒ 任何**未跟踪**的草稿/生成物（例如在工作台里让 agent 现写的练习文件）
 * 都会让**所有**提交被拦下，而它根本不在本次提交里。改为：只扫 `git ls-files` 列出的文件
 * （索引 = 已跟踪 ∪ 已暂存）——这正是「代码库」的机械定义；CI 全量 checkout 时覆盖不变。
 * git 不可用时退化为全量扫描（宁可严，不可漏）。
 *
 * ## 判据与失败面
 *
 * - 顶层（`SourceFile.statements`）出现 `FunctionDeclaration` 即红——**不**递归进函数体/类体：
 *   类静态方法（`MethodDeclaration`）与嵌套闭包都不算违规。
 * - `--selftest`：对内置正反样例跑解析器，断言「函数声明判红 / 类静态方法判绿」（门禁自身的可证伪性）。
 * - `--list`：打印当前违规清单（文件:行:函数名）便于整改。
 *
 * 用法：`node scripts/auditTopLevelFunctions.mjs [--selftest|--list]`
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 纳入范围：生产源码根目录（相对仓库根）。 */
const SCOPE = ['src'];
/** 排除的路径前缀（相对仓库根，正斜杠）。 */
const EXCLUDE_PREFIXES = ['web/src/ui/'];

/**
 * git 索引里的文件集合（相对仓库根，正斜杠）。
 *
 * ## 为什么必须显式写 `stdio`（2026-09-28 实测）
 *
 * `execFileSync('git', …)` 默认 `stdio` 的 **stdin 是管道**，而本机（Windows）在这种情况下
 * 直接 `EBUSY`（`spawnSync git EBUSY`）——与「同步 / 异步」无关：同步版把 stdin 改为 `'ignore'`
 * 就立刻恢复（实测正常返回 53311 字节），异步版同样可用。
 *
 * 这个坑曾经以**最坏的形式**暴露：拿不到索引 ⇒ 静默退化为全量扫描 ⇒ **未跟踪的草稿**
 * （并行会话正在写的文件）让**所有**提交被误拦，而它根本不在本次提交里。
 * 故本函数失败时不再沉默，由调用方打印原因。
 *
 * @returns 文件路径集合；git 不可用时为 null（调用方退化为全量扫描并说明）。
 */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split('\0').filter((s) => s !== ''));
  } catch {
    return null;
  }
}

/** 索引文件集合（模块级取一次）。 */
const TRACKED = trackedFiles();
if (TRACKED === null) {
  console.error(
    '⚠️  无法读取 git 索引（`git ls-files` 执行失败）⇒ 退化为全量扫描：未跟踪的草稿也会被判定，' +
      '可能出现「不在本次提交里却被拦下」的假红。若为 stdin 管道问题，请确认调用处显式传了 ' +
      "`stdio: ['ignore','pipe','ignore']`。",
  );
}

/**
 * 递归收集纳入范围的 .ts 文件（只收 git 索引里的；未跟踪草稿不算代码库）。
 * @param dir 绝对目录。
 * @param out 累积数组。
 * @returns 文件绝对路径数组。
 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    const rel = relative(ROOT, full).replace(/\\/g, '/');
    if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (TRACKED !== null && !TRACKED.has(rel)) continue;
    out.push(full);
  }
  return out;
}

/**
 * 取一份源码里的**顶层函数声明**。
 * @param file 文件绝对路径（仅用于诊断）。
 * @param text 源码文本。
 * @returns 违规项（名称 + 行号）。
 */
export function topLevelFunctionsOf(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
      out.push({ name: stmt.name?.text ?? '(anonymous)', line });
    }
  }
  return out;
}

const args = new Set(process.argv.slice(2));

if (args.has('--selftest')) {
  const bad = topLevelFunctionsOf('x.ts', 'export function alpha(): number {\n  return 1;\n}\n');
  const good = topLevelFunctionsOf(
    'y.ts',
    'export class Beta {\n  public static alpha(): number {\n    return 1;\n  }\n}\n',
  );
  const arrow = topLevelFunctionsOf('z.ts', 'export const gamma = (): number => 1;\n');
  const ok =
    bad.length === 1 && bad[0]?.name === 'alpha' && good.length === 0 && arrow.length === 0;
  console.log(
    ok
      ? '✅ auditTopLevelFunctions --selftest：函数声明判红 / 类静态方法判绿 / 箭头常量不判（口径正确）'
      : `❌ selftest 失败：bad=${JSON.stringify(bad)} good=${JSON.stringify(good)} arrow=${JSON.stringify(arrow)}`,
  );
  process.exit(ok ? 0 : 1);
}

const files = SCOPE.flatMap((d) => collect(join(ROOT, d)));
const violations = [];
for (const f of files) {
  for (const v of topLevelFunctionsOf(f, readFileSync(f, 'utf8'))) {
    violations.push({ file: relative(ROOT, f).replace(/\\/g, '/'), ...v });
  }
}

if (args.has('--list')) {
  for (const v of violations) console.log(`  ${v.file}:${v.line}  ${v.name}`);
}
if (violations.length > 0) {
  console.error(
    `❌ 顶层 function 声明 ${violations.length} 处（非 UI .ts 必须以 export class 实现，见文件头口径）：`,
  );
  for (const v of violations.slice(0, 40)) console.error(`  ${v.file}:${v.line}  ${v.name}`);
  if (violations.length > 40) console.error(`  …其余 ${violations.length - 40} 处见 --list`);
  process.exit(1);
}
console.log(`✅ 顶层 function 门禁通过：${files.length} 个非 UI .ts 文件零函数声明`);
