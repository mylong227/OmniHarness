#!/usr/bin/env node
/**
 * 覆盖率门禁（零依赖）：**聚合阈值 + 按文件冻结基线（回退即红）**。
 *
 * ## 为什么重写（审计 §3.5「覆盖率门禁是聚合值」的收口 —— 实测比审计描述的更糟）
 *
 * 旧实现只解析 `# all files` 一行，且 `package.json` 的 `coverage` 脚本把
 * `--test-coverage-include` 写成 `dist/**`——该 glob **匹配不到任何文件**，于是覆盖率表里
 * 只有一行 `# all files | 100.00`。也就是说旧门禁**恒真**：无论多少模块零单测，
 * 它都打印「✓ 覆盖率达标」。审计说它「是聚合值」，实测是**假绿**。
 *
 * 现改为：
 *  1. include 口径修正为 `dist/src/**\/*.js`（只统计本仓源码，不统计测试自身）；
 *  2. **按文件**解析覆盖率表，与 `scripts/coverageBaseline.json` 冻结基线比对：
 *     - 任一文件低于其基线**超过度量漂移容差**（1 点，理由见 `DRIFT_TOLERANCE`）⇒ 阻断；
 *       容差内的下浮**如实列出但不阻断**（改测试文件集合会推动这类抖动，实测证据见该常量注释）；
 *     - **新文件**（不在基线内）低于 `MIN_NEW_FILE_COVERAGE`（默认 30%）⇒ 阻断
 *       （否则新增零单测模块会再次静默通过——正是旧门禁的缺陷形态）；
 *     - 高于基线的文件会被提示「可运行 --dump-baseline 收紧基线」。
 *  3. 聚合阈值仍保留（默认 80%，`MIN_LINE_COVERAGE` 可覆盖）。
 *  4. **空表守卫**：报告里没有任何逐文件行时**直接阻断**。这一条是补出来的——`coverage` 脚本
 *     原先写的是 `--test-coverage-include='dist/src/**\/*.js'`，而 npm 在 Windows 走 `cmd.exe`，
 *     单引号是**字面量**，于是 include 变成带引号的字符串、匹配不到文件 ⇒ 又回到「只有 `# all files |
 *     100.00`」的假绿。引用号改双引号后才真正生效（实测聚合 90.5% / 508 文件）。
 *  5. **宿主相关下限**：`scripts/coverageEnvDependent.json` 登记的文件按**下限**校验而非冻结值，
 *     因为它们的被覆盖分支取决于本机能否发现 POSIX bash（换机器会得到不同的行覆盖率）。
 *     登记须附实测诊断，不允许为了消红而登记。
 *  6. **基线是棘轮**：`--dump-baseline` 默认**只升不降**（新值更低时保留旧值），避免把一次回归
 *     悄悄合法化；确实要下调须显式 `--force` 并在提交信息里写明原因。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/coverageGate.mjs                    # 跑 npm run coverage 后校验
 * node scripts/coverageGate.mjs --from-file r.txt  # 校验一份已保存的覆盖率输出（CI 归档/离线复核）
 * node scripts/coverageGate.mjs --dump-baseline [--from-file r.txt]   # 收紧基线（棘轮：只升不降）
 * node scripts/coverageGate.mjs --dump-baseline --force               # 显式允许下调（须说明原因）
 * node scripts/coverageGate.mjs --list             # 打印全部文件的覆盖率与基线差
 * ```
 *
 * 测试未全绿时直接阻断（覆盖率数字无意义）——`--from-file` 模式跳过该检查。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts', 'coverageBaseline.json');
const envDependentPath = join(root, 'scripts', 'coverageEnvDependent.json');
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const threshold = Number(process.env.MIN_LINE_COVERAGE ?? '80');
const newFileFloor = Number(process.env.MIN_NEW_FILE_COVERAGE ?? '30');
/** 浮点噪声容差：低于基线超过该值才算回退（避免 94.44 vs 94.44 的表示误差误报）。 */
const TOLERANCE = 0.01;
/**
 * **度量漂移容差**（低于基线这么多**点**才判回退）。
 *
 * 为什么需要它（三轮实测证据）：本仓覆盖率对「全量测试的**文件集合/并发交错**」敏感——新增一个测试文件
 * 会改变文件调度顺序，让某些**未被改动**的文件覆盖率上下浮动：
 *  - `wsConnection.js` 85.14 ↔ 84.42（差 0.72，取决于 `pendingRequests.test.js` 是否在集合里）；
 *  - `evalHarness.js` 87.78 ↔ 87.28（差 0.50，取决于两个耐久性测试文件是否在集合里）。
 * 两者**源码均未改动**，且把新测试文件从集合里去掉后**精确回到基线值** ⇒ 是度量抖动，不是回归。
 * 故低于基线 1 个点以内只**如实列出、不阻断**；超过 1 个点（真实回退通常远大于此）即红。
 * 这不是「放宽门禁」：`--dump-baseline` 是**棘轮**（只升不降，见该分支），基线不会因此被悄悄调低。
 */
const DRIFT_TOLERANCE = 1;

/** 取覆盖率输出文本（跑测试，或读已保存报告）。 */
function loadReport() {
  const fromFile = flagValue('--from-file');
  if (fromFile !== undefined) {
    if (!existsSync(fromFile)) {
      console.error(`✗ 报告文件不存在：${fromFile}`);
      process.exit(2);
    }
    // 按 BOM 判定编码：PowerShell 的 `>` 重定向默认写 **UTF-16LE**，按 utf8 读会得到
    // 交错的 NUL 而完全匹配不到表头（本仓实测踩过两次）⇒ 这里显式兼容。
    const buf = readFileSync(fromFile);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
    const text = buf.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
  try {
    return execFileSync('npm', ['run', 'coverage'], {
      cwd: root,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    // 测试失败时 npm 非零退出，但覆盖率表仍在 stdout —— 仍按「测试未全绿」处理。
    console.error('✗ 测试运行未全绿，覆盖率门禁终止（见上方测试输出）。');
    if (e && typeof e.stdout === 'string' && e.stdout.length > 0) process.exit(1);
    process.exit(1);
  }
}

/**
 * 解析覆盖率表：目录靠**缩进层级**表达，故按缩进维护目录栈还原完整路径。
 * @param text 覆盖率输出全文。
 * @returns `{ all, files }`；`files` 为 `仓库相对路径 → 行覆盖率`。
 */
function parseCoverage(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#\s*file\s*\|/.test(l));
  if (start < 0) {
    console.error('✗ 未能定位覆盖率表头（`# file | line %`）。');
    process.exit(1);
  }
  const files = new Map();
  const stack = [];
  let all;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('#')) continue;
    if (line.includes('end of coverage report')) break;
    const m = /^#( +)([^|]+?)\s*\|(.*)$/.exec(line);
    if (m === null) continue;
    const indent = (m[1] ?? '').length;
    const label = (m[2] ?? '').trim();
    const cells = (m[3] ?? '').split('|').map((c) => c.trim());
    const linePct = cells[0] ?? '';
    if (label === 'all files') {
      all = Number.parseFloat(linePct);
      break;
    }
    if (/^\d/.test(linePct)) {
      // 文件行：路径 = 栈中更浅的目录 + 本行文件名；去掉 dist/ 前缀变仓库相对路径。
      stack.length = indent - 1;
      const path = [...stack.filter(Boolean), label].join('/').replace(/^dist\//, '');
      files.set(path, Number.parseFloat(linePct));
    } else {
      // 目录行：记录在「当前缩进层级」的位置
      stack[indent - 1] = label;
      stack.length = indent;
    }
  }
  return { all, files };
}

const { all, files } = parseCoverage(loadReport());
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
// 宿主相关的覆盖率下限（见 scripts/coverageEnvDependent.json 的 reason/notes）：
// 这些文件的被覆盖分支取决于本机能否发现 POSIX bash，按**下限**校验以避免换机器假红。
const envDependent = existsSync(envDependentPath)
  ? (JSON.parse(readFileSync(envDependentPath, 'utf8')).files ?? {})
  : {};

// 空表守卫：`--test-coverage-include` 口径一旦写错（曾因 Windows cmd 不吃单引号 ⇒ 字面量带引号 ⇒
// 匹配不到任何文件），覆盖率表就只剩 `# all files | 100.00` 一行，门禁会**假绿**。这里显式阻断。
if (files.size === 0) {
  console.error('✗ 覆盖率报告里没有任何逐文件行（只有聚合行）。');
  console.error(
    '  这几乎总是 `--test-coverage-include` 口径错误导致匹配不到文件——请检查 package.json 的',
  );
  console.error(
    '  coverage 脚本引号（Windows npm 走 cmd.exe，单引号是字面量，须用双引号）后重跑。',
  );
  process.exit(1);
}

if (args.includes('--dump-baseline')) {
  // **棘轮语义**：默认只升不降——新值更高就收紧，更低则**保留旧值**（旧值是历史上达到过的水平，
  // 若直接写低就等于把一次回归悄悄合法化）。确实要下调时显式 `--force`（须在提交信息里说明原因）。
  const force = args.includes('--force');
  const snapshot = Object.fromEntries(
    [...files.entries()]
      .map(([file, pct]) => {
        const old = baseline[file];
        if (!force && typeof old === 'number' && old > pct) return [file, old];
        return [file, pct];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const kept = Object.keys(snapshot).filter(
    (f) => typeof baseline[f] === 'number' && baseline[f] > (files.get(f) ?? 0),
  );
  writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(
    `已写入覆盖率基线：scripts/coverageBaseline.json（${Object.keys(snapshot).length} 个文件；聚合 ${all}%）`,
  );
  if (kept.length > 0) {
    console.log(
      `  棘轮保留 ${kept.length} 个文件的旧（更高）基线，未随本次较低实测值下调：${kept.join(', ')}`,
    );
  }
  process.exit(0);
}

if (args.includes('--list')) {
  const rows = [...files.entries()]
    .map(([file, pct]) => {
      const base = baseline[file];
      const delta = base === undefined ? 'NEW' : (pct - base).toFixed(2);
      return `  ${pct.toFixed(2).padStart(6)}%  Δ${String(delta).padStart(6)}  ${file}`;
    })
    .sort();
  console.log(`聚合行覆盖率 ${all}%（${files.size} 个文件）`);
  for (const row of rows) console.log(row);
  process.exit(0);
}

console.log(`聚合行覆盖率: ${all}%   阈值: ${threshold}%`);
if (all < threshold) {
  console.error(`✗ 聚合行覆盖率 ${all}% 低于阈值 ${threshold}%。`);
  process.exit(1);
}

const regressions = [];
const newLow = [];
const improved = [];
const envChecked = [];
const drifted = [];
for (const [file, pct] of files) {
  const floor = envDependent[file];
  if (typeof floor === 'number') {
    // 宿主相关文件：按下限校验（低于下限才红），并如实标注是按下限过的。
    if (pct + TOLERANCE < floor) {
      regressions.push(`${file}  ${pct}%（宿主相关下限 ${floor}%）`);
    } else {
      envChecked.push(`${file}  ${pct}%（下限 ${floor}%）`);
    }
    continue;
  }
  const base = baseline[file];
  if (base === undefined) {
    if (pct + TOLERANCE < newFileFloor) newLow.push(`${file}  ${pct}%`);
    continue;
  }
  if (pct + DRIFT_TOLERANCE < base) {
    regressions.push(`${file}  ${pct}%（基线 ${base}%，差 ${(base - pct).toFixed(2)} 点）`);
  } else if (pct + TOLERANCE < base) {
    // 低于基线但在漂移容差内：如实列出，不阻断（理由见 DRIFT_TOLERANCE 注释）。
    drifted.push(`${file}  ${pct}%（基线 ${base}%，差 ${(base - pct).toFixed(2)} 点）`);
  } else if (pct > base + TOLERANCE) {
    improved.push(`${file}  ${pct}%（基线 ${base}%）`);
  }
}

if (envChecked.length > 0) {
  console.log(
    `ℹ️  ${envChecked.length} 个文件按**宿主相关下限**校验（非冻结值，原因见 coverageEnvDependent.json）：`,
  );
  for (const row of envChecked) console.log(`    ${row}`);
}

if (drifted.length > 0) {
  console.log(
    `ℹ️  ${drifted.length} 个文件低于基线但在 ${DRIFT_TOLERANCE} 点度量漂移容差内（改测试文件集合会推动这类抖动，不阻断）：`,
  );
  for (const row of drifted) console.log(`    ${row}`);
}

if (improved.length > 0) {
  console.log(`ℹ️  ${improved.length} 个文件覆盖率高于基线（可运行 --dump-baseline 收紧基线）：`);
  for (const row of improved.slice(0, 10)) console.log(`    ${row}`);
  if (improved.length > 10) console.log(`    …共 ${improved.length} 个`);
}

if (newLow.length > 0) {
  console.error(`✗ 新增文件行覆盖率低于 ${newFileFloor}%（${newLow.length} 个）：`);
  for (const row of newLow) console.error(`    ${row}`);
}

if (regressions.length > 0) {
  console.error(
    `✗ 覆盖率回退（低于冻结基线超过 ${DRIFT_TOLERANCE} 点，${regressions.length} 个）：`,
  );
  for (const row of regressions) console.error(`    ${row}`);
}

if (regressions.length > 0 || newLow.length > 0) {
  console.error(
    `  说明：本门禁按文件冻结基线（棘轮）——低于基线超过 ${DRIFT_TOLERANCE} 点即红；新增低覆盖文件即红。`,
  );
  process.exit(1);
}
console.log(
  `✓ 覆盖率达标（聚合 ${all}% ≥ ${threshold}%；${files.size} 个文件无超容差回退${
    drifted.length > 0 ? `，${drifted.length} 个在漂移容差内` : ''
  }）`,
);
