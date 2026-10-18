#!/usr/bin/env node
/**
 * 覆盖率门禁（无第三方依赖）：**聚合阈值 + 按文件冻结基线（回退即红）**。
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
 * node scripts/coverageGate.mjs                    # 跑 npm run coverage 后校验（消费 .coverage/coverage-summary.json）
 * node scripts/coverageGate.mjs --from-json .coverage/coverage-summary.json  # 校验已生成的 JSON（CI 归档/离线复核/本地重基线）
 * node scripts/coverageGate.mjs --from-json .coverage/coverage-summary.json --dump-baseline   # 收紧基线（棘轮：只升不降）
 * node scripts/coverageGate.mjs --from-json .coverage/coverage-summary.json --dump-baseline --force   # 显式允许下调（须说明原因）
 * node scripts/coverageGate.mjs --from-json .coverage/coverage-summary.json --list           # 打印全部文件的覆盖率与基线差
 * ```
 *
 * 测试未全绿时直接阻断（覆盖率数字无意义）——`--from-json` 离线模式跳过该检查。
 *
 * ## 2026-10-17 测试栈统一后的口径变更（重要）
 *
 * 迁移前本门禁解析 `node --test --experimental-test-coverage` 的 **TAP 文本表**（`# file | line %`，
 * 缩进表目录层级），基线键是编译产物 `dist/src/**\/*.js`。迁移后后端判据走 **vitest v8 覆盖率**，
 * 直接测**源码** `src/**`，报告是 `coverage.reporter=json-summary` 产出的
 * `coverage-summary.json`（键为 `src/...ts` 绝对/相对路径，值为 `lines.pct`）。故本脚本相应改为：
 *   1. 解析 JSON 摘要（不再解析 TAP 文本）；离线复核从 `--from-file`(文本) 改为 `--from-json`(JSON)；
 *   2. 文件清点从扫描 `dist/src/**\/*.js` 改为扫描 `src` 下的 `.ts` / `.tsx` 源码（纯类型源码判定也改读源码）；
 *   3. 聚合行覆盖率改为「仅统计**被执行的文件**」（`lines.covered > 0`）——v8 会把 `include` 命中的
 *      **每一个** `src` 文件都列进报告（未执行者 0%），若把 0% 文件计入分母会让聚合值被未触及文件
 *      拉到极低而误红；这与迁移前 `node --test` 只插桩「被加载模块」的聚合语义一致。
 *   4. 三份基线（coverageBaseline / coverageInventoryBaseline / coverageEnvDependent）全部重新按
 *      `src/...ts` 键 + 本次实测重测——属一次性重基线，提交信息须写明（见 PROJECT_BOARD §13）。
 * 因为 v8 会把所有 `src` 文件都列进报告（含 0%），旧的「文件没进报告」清点机制天然失效；
 * 其防御意图（拦下「新增零单测模块」）现由「新文件 < 30% 下限」分支承接（0% 新文件即红）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CAPTURE_BYTES, classifyRunFailure } from './lib/childRunFailure.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts', 'coverageBaseline.json');
const envDependentPath = join(root, 'scripts', 'coverageEnvDependent.json');
/**
 * 「文件清点」基线（按平台分列）。
 *
 * 为什么需要它（2026-10-11 实测缺口）：本门禁的主循环是 `for (const [file, pct] of files)`，
 * 而 Node 的覆盖率报告**只列它插桩过的文件**——一个模块若一行都没执行过（从未被任何测试 import，
 * 或只导出类型而无可执行语句），它在报告里**根本不出现** ⇒ 逐文件棘轮、`NEW<30%` 下限
 * 两条分支**都触不到它**。后果：新增一个没人测的模块，门禁照样全绿（本仓"0 项=通过"族的新变体）。
 * 清点基线把"已知未进报告"的集合冻结下来，**新增**一个就红。
 */
const inventoryBaselinePath = join(root, 'scripts', 'coverageInventoryBaseline.json');
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
 * 为什么需要它（**四轮实测证据**，每条都用「把新增测试文件从全量集合里去掉后精确回到基线」验证过，
 * 即：源码未改、仅测试文件集合/并发交错变化 ⇒ 度量抖动而非回归）：
 *
 * | 文件 | 抖动幅度 | 触发条件 |
 * |---|---|---|
 * | `wsConnection.js` | 0.72 | 是否包含 `pendingRequests.test.js` |
 * | `evalHarness.js` | 0.50 | 是否包含两个耐久性测试文件 |
 * | `jsonFileKv.js` | **2.41** | 是否包含 `tokenCountCache.test.js` |
 * | `memoryStackAssembler.js` | **1.59** | 同上 |
 *
 * 故取 **2.5**：覆盖已观测到的最大抖动并留余量。**诚实边界**：小于该幅度的**真实**回退
 * 与噪声无法可靠区分——这正是「棘轮 + 每轮复核」要配合的原因（`--dump-baseline` 只升不降，
 * 而确实要下调时必须先做上面那个排除实验并在提交信息里写明）。
 *
 * 这不是「放宽门禁」：`--dump-baseline` 是**棘轮**（只升不降，见该分支），基线不会被悄悄调低；
 * 而换机器就会变的宿主差异（`bashAppRootMapper` 约 6 点）走 `coverageEnvDependent.json` 的下限表。
 */
const DRIFT_TOLERANCE = 2.5;

/** 取覆盖率输出文本（跑测试，或读已保存报告）。 */
/**
 * 取覆盖率 JSON 摘要（跑测试产出，或读已保存的 JSON）。
 * @returns `{ summary, offline, ranGreen }`：
 *   - `summary`：解析后的 `coverage-summary.json` 对象；
 *   - `offline`：`true` 表示来自 `--from-json`（离线模式，跳过「测试须全绿」检查）；
 *   - `ranGreen`：`false` 表示 `npm run coverage` 实际非零退出（有用例失败）。
 */
const COVERAGE_JSON = join(root, '.coverage', 'coverage-summary.json');
function readJsonAware(p) {
  const buf = readFileSync(p);
  let text = buf.toString('utf8');
  // BOM 兼容：PowerShell `>` 重定向默认写 UTF-16LE，本仓曾踩两次。
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}
function loadReport() {
  const fromJson = flagValue('--from-json');
  if (fromJson !== undefined) {
    if (!existsSync(fromJson)) {
      console.error(`✗ 覆盖率 JSON 文件不存在：${fromJson}`);
      process.exit(2);
    }
    // 离线模式：直接消费已生成的 JSON，跳过「测试须全绿」检查（CI 归档 / 本地用已生成的报告重基线）。
    return { summary: readJsonAware(fromJson), offline: true, ranGreen: true };
  }
  try {
    execFileSync('npm', ['run', 'coverage'], {
      cwd: root,
      encoding: 'utf8',
      shell: true,
      // 覆盖率 JSON 才是判据真相源；stdout 仍透传给人看（text reporter），stderr 透传便于排障。
      stdio: ['ignore', 'inherit', 'inherit'],
      maxBuffer: MAX_CAPTURE_BYTES,
    });
    if (!existsSync(COVERAGE_JSON)) {
      console.error('✗ 覆盖率 JSON 报告未生成：.coverage/coverage-summary.json');
      console.error(
        '  `npm run coverage` 跑完了却没写出 JSON——多半是 coverage provider 未装（需 @vitest/coverage-v8）。',
      );
      process.exit(2);
    }
    return { summary: readJsonAware(COVERAGE_JSON), offline: false, ranGreen: true };
  } catch (e) {
    // 分类而非一律归因：测试没跑起来（npm 不在 PATH / spawn 失败 / OOM / provider 缺失）与
    // 用例失败是两件事。只要 JSON 已落盘，就仍然返回（由主流程据 ranGreen=false 阻断）；
    // 连 JSON 都没有 ⇒ 是「测试压根没跑起来」，如实分类后退出。
    if (existsSync(COVERAGE_JSON)) {
      return { summary: readJsonAware(COVERAGE_JSON), offline: false, ranGreen: false };
    }
    const err = e && typeof e.stderr === 'string' ? e.stderr : '';
    const kind = classifyRunFailure(e);
    console.error('✗ 覆盖率门禁终止：**测试可能根本没跑起来**（未生成覆盖率 JSON）。');
    console.error(
      `  退出码=${String((e && e.status) ?? '(无)')}｜信号=${String((e && e.signal) ?? '(无)')}｜` +
        `分类=${kind}｜原因=${String((e && e.message) ?? e).slice(0, 300)}`,
    );
    if (err.trim() !== '') {
      console.error('  子进程 stderr（前 20 行）：');
      for (const l of err.split('\n').slice(0, 20)) console.error(`    ${l}`);
    }
    process.exit(1);
  }
}

/**
 * 解析 vitest v8 的 `coverage-summary.json`。
 *
 * 键为各源文件的路径（本机为绝对 Windows 路径如 `D:\...\src\x.ts`，CI 为 `/home/.../src/x.ts`），
 * 值含 `lines:{total,covered,skipped,pct}` 等。v8 会把 `include` 命中的**每一个** `src` 文件都列进来
 * （未执行者 `pct:0`），故：
 *   · 逐文件键统一规整为仓库相对 `src/...ts`（去掉根前缀、统一斜杠）；
 *   · 聚合行覆盖率**只统计被执行的文件**（`lines.covered > 0`），避免未触及文件把分母拉爆；
 *     这与迁移前 `node --test` 只插桩「被加载模块」的聚合语义一致。
 * @param summary JSON 对象。
 * @param rootDir 仓库根（用于规整绝对路径键）。
 * @returns `{ all, files }`；`files` 为 `仓库相对路径 → 行覆盖率`。
 */
function normalizeKey(key, rootNorm) {
  let k = key.replace(/\\/g, '/');
  if (k.toLowerCase().startsWith(rootNorm)) k = k.slice(rootNorm.length).replace(/^\/+/, '');
  if (!k.startsWith('src/')) return null;
  return k;
}
function parseSummary(summary, rootDir) {
  const rootNorm = rootDir.replace(/\\/g, '/').toLowerCase();
  const files = new Map();
  let allCovered = 0;
  let allTotal = 0;
  for (const [key, block] of Object.entries(summary)) {
    if (key === 'total') continue;
    const rel = normalizeKey(key, rootNorm);
    if (rel === null) continue;
    const lines = block && block.lines ? block.lines : { total: 0, covered: 0, pct: 0 };
    const pct = Number(lines.pct) || 0;
    files.set(rel, pct);
    const covered = Number(lines.covered) || 0;
    if (covered > 0) {
      allCovered += covered;
      allTotal += Number(lines.total) || 0;
    }
  }
  const all = allTotal > 0 ? (allCovered / allTotal) * 100 : 0;
  return { all, files };
}

/**
 * 列出覆盖率口径覆盖到的**全部**源码文件（`src` 下的 `.ts` / `.tsx`）。
 *
 * 2026-10-17 测试栈统一后，覆盖率直接测**源码**而非 `dist` 产物：v8 provider 对 `coverage.include=src/**`
 * 命中的**每一个** `src` 文件都列进报告（未执行者 `pct:0`）。故这里递归收集 `src` 下的每个
 * `.ts` / `.tsx`（含根层文件）。返回仓库相对路径（`src/...ts`），与 `parseSummary` 的键口径一致。
 *
 * 注：v8 会把所有命中文件都列进报告（含 0%），所以 `--dump-inventory` 分支算出的 `missing`
 * （报告里没出现的文件）在 v8 口径下**恒为空**——「新增零单测模块」的防御改由「新文件 < 30% 下限」
 * 分支承接。本清点函数保留，作为报告键合法性自证（报告里出现 `src/` 之外文件 ⇒ 口径不一致，直接红）。
 * @returns 仓库相对路径（`/` 分隔，升序）。
 */
function listIncludedFiles() {
  const base = join(root, 'src');
  if (!existsSync(base)) {
    console.error(`✗ 文件清点需要源码目录，但它不存在：${base}`);
    console.error('  清点要回答的是"哪些源文件一行都没执行过"，缺了源码集合就无从判定。');
    process.exit(2);
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(base);
  return out.sort();
}

/**
 * 源码文件是否为**纯类型模块**（没有任何可执行语句）。
 *
 * 为什么必须把它从清点里排除：`export interface` / `export type` / 仅 `import type` 的 `.ts`，
 * 编译后只剩 `export {};`，**没有可执行行**——v8 仍会把它列进报告（0%），但那是**无意义读数**
 * 而非"缺判据"。把它逐条登记进清点基线只会让基线退化成"类型文件清单"。（本仓 2026-10-11 在
 * 编译产物口径下实测过同一现象。）
 *
 * 判据**从严**：只要出现任何一条非空、非注释、且不是 `export {};` / `export type …` /
 * `import type …` 的语句，就仍按"可执行源码"处理（照旧进清点与逐文件棘轮）。
 * @param abs 源码绝对路径。
 * @returns 无任何可执行语句时为 true。
 */
function isTypeOnlyArtifact(abs) {
  for (const raw of readFileSync(abs, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*'))
      continue;
    if (line === 'export {};' || line === 'export {}') continue;
    if (/^export\s+type\s/u.test(line) || /^import\s+type\s/u.test(line)) continue;
    return false;
  }
  return true;
}

/**
 * 把"没进覆盖率报告"的源文件分成两类：**可执行但没跑过**（真缺口，进清点基线）与
 * **纯类型模块**（无可执行行，读数无意义，不进基线）。
 *
 * 2026-10-17 口径变更：v8 会把 `include` 命中的**每一个** `src` 文件都列进报告（含 0%），
 * 所以 `missing`（报告里没出现的文件）在 v8 口径下**恒为空**；本函数保留以复用同一份
 * 类型判定（避免 dump 分支与报告分支口径分叉）。`missing` 为空时清点分支不会误红。
 * @param includedFiles `listIncludedFiles()` 的结果。
 * @param reportedSet 覆盖率报告里出现过的文件集合。
 * @returns `{ missing, typeOnly }`（`missing` = 需要进清点基线的可执行源文件）。
 */
function classifyMissingArtifacts(includedFiles, reportedSet) {
  const typeOnly = [];
  const missing = [];
  for (const f of includedFiles) {
    if (reportedSet.has(f)) continue;
    const abs = join(root, f);
    if (existsSync(abs) && isTypeOnlyArtifact(abs)) typeOnly.push(f);
    else missing.push(f);
  }
  return { missing, typeOnly };
}

const load = loadReport();
const { all, files } = parseSummary(load.summary, root);
// 「测试未全绿 ⇒ 覆盖率数字无意义」：默认模式（非离线）下 ranGreen=false 直接阻断。
// 离线（`--from-json`）模式跳过该检查（CI 归档复核 / 本地用已生成的报告重基线）。
if (!load.offline && !load.ranGreen) {
  console.error('✗ 覆盖率门禁终止：测试运行未全绿（npm run coverage 非零退出）。');
  console.error(
    '  先用 `npm test` 把失败用例清零，再跑本门禁；或离线用 --from-json 指定已生成的 JSON。',
  );
  process.exit(1);
}
// 基线**缺失即阻断**：静默退化成 `{}` 会让逐文件棘轮消失（只剩"新文件 30% 下限"）⇒
// 所有存量回归一次性合法化，而输出仍是「✓ 覆盖率达标」。本仓纪律与此一致：
// `check.mjs` 对白名单缺失是阻断级、`docLinkCheck` 的基线缺失也 fail-closed（2026-10-06 排查修正）。
if (!existsSync(baselinePath)) {
  console.error(`✗ 缺覆盖率基线：${baselinePath}`);
  console.error('  没有基线就没有"逐文件只升不降"的棘轮，门禁会静默退化 ⇒ 此处 fail-closed。');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
// 宿主相关的覆盖率下限（见 scripts/coverageEnvDependent.json 的 reason/notes）：
// 这些文件的被覆盖分支取决于本机能否发现 POSIX bash，按**下限**校验以避免换机器假红。
const envDependentRaw = existsSync(envDependentPath)
  ? JSON.parse(readFileSync(envDependentPath, 'utf8'))
  : {};
const envDependent = envDependentRaw.files ?? {};

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

// 聚合值守卫：表里没有 `# all files` 行、或该行不是数字时，`all` 会是 undefined/NaN，而
// `all < threshold` 对 NaN **恒为 false** ⇒ 门禁静默通过并打印「聚合 undefined% ≥ 80%」。
// 可达路径包括文档化的 `--from-json`（喂已生成的 JSON 报告）与 reporter 变更（2026-10-06 排查修正）。
if (!Number.isFinite(all)) {
  console.error(`✗ 覆盖率报告缺 'all files' 聚合行（或该行非数字）：all=${String(all)}。`);
  console.error('  阈值判定无法进行 ⇒ fail-closed（不再打印"达标"）。');
  process.exit(1);
}
for (const [name, value] of [
  ['MIN_LINE_COVERAGE', threshold],
  ['MIN_NEW_FILE_COVERAGE', newFileFloor],
]) {
  if (!Number.isFinite(value)) {
    console.error(
      `✗ 环境变量 ${name} 不是数字（收到 "${String(process.env[name])}"）⇒ 阈值无法判定。`,
    );
    process.exit(1);
  }
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

if (args.includes('--dump-inventory')) {
  // **棘轮语义**（与 --dump-baseline 同口径）：收紧（少登记）随意；**扩张**必须显式 `--force`。
  // 扩张意味着"又有一个文件一行都没执行过"，那本该先问"为什么没有判据"，而不是顺手登记进去。
  const force = args.includes('--force');
  const raw = existsSync(inventoryBaselinePath)
    ? JSON.parse(readFileSync(inventoryBaselinePath, 'utf8'))
    : {};
  const platforms = raw.platforms ?? {};
  const old = Array.isArray(platforms[process.platform]) ? platforms[process.platform] : [];
  const oldSet = new Set(old);
  const included = listIncludedFiles();
  const reported = new Set(files.keys());
  const { missing, typeOnly } = classifyMissingArtifacts(included, reported);
  const added = missing.filter((f) => !oldSet.has(f));
  const cleared = old.filter((f) => !missing.includes(f));
  if (added.length > 0 && !force) {
    console.error(
      `✗ 本次清点比 ${process.platform} 基线**多出 ${added.length} 个"没进覆盖率报告"的文件**：`,
    );
    for (const f of added) console.error(`    ${f}`);
    console.error('  "多出"= 这些文件本次一行都没执行过（没有任何判据碰到它们）。');
    console.error('  首选是给它们补判据；确属设计（例如只导出类型的模块）才登记，且必须显式：');
    console.error(`    node scripts/coverageGate.mjs --from-json <报告> --dump-inventory --force`);
    console.error('  并在提交信息里写明"为什么这个文件无法被覆盖"。');
    process.exit(1);
  }
  writeFileSync(
    inventoryBaselinePath,
    `${JSON.stringify({ ...raw, platforms: { ...platforms, [process.platform]: missing } }, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `已写入文件清点基线（${process.platform}）：scripts/coverageInventoryBaseline.json` +
      `（源文件 ${included.length} 个 ｜ 未进报告 ${missing.length} 个` +
      `${typeOnly.length > 0 ? `（另有 ${typeOnly.length} 个纯类型模块不计入）` : ''}` +
      `${added.length > 0 ? ` ｜ 本次新增登记 ${added.length} 个` : ''}` +
      `${cleared.length > 0 ? ` ｜ 已清偿 ${cleared.length} 个` : ''}）`,
  );
  if (added.length > 0) {
    console.log('  本次**新增登记**（这些是"已知未覆盖"，不是"没问题"）：');
    for (const f of added) console.log(`    ${f}`);
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

// ---- 环境探测（2026-09-25，CI 三平台首跑实证）----
// 下限本身也可能**按环境而变**：同一文件「本机（有原生 .node / bash 是 WSL 存根）」与
// 「CI（无原生 / 真 bash）」的可达分支不同。两类环境差异都经实测诊断后在
// coverageEnvDependent.json 的 environmentFloors 里登记，这里探测环境并选用对应下限，
// 且**显式打印**正在用哪套（不静默换尺子）。
const nativeModulePath = join(root, 'native', 'omni_napi.node');
const nativeMissing = !existsSync(nativeModulePath);
const isPosix = process.platform !== 'win32';
let realBash = false;
try {
  execFileSync('bash', ['-c', '[ -n "$BASH_VERSION" ]'], { stdio: 'ignore' });
  realBash = true;
} catch {
  realBash = false;
}
const envFloorsAll = envDependentRaw.environmentFloors ?? {};
const envKey = [];
if (nativeMissing) {
  envKey.push('native 缺席');
  process.env.OMNI_COVERAGE_NATIVE_ABSENT = '1';
}
if (isPosix) envKey.push('POSIX 平台');
console.log(
  `ℹ️ 环境：native/omni_napi.node ${nativeMissing ? '缺席（原生依赖文件按 environmentFloors.nativeAbsent 下限）' : '在场（按冻结基线棘轮）'}；平台 ${process.platform}${isPosix ? '（平台语义文件按 environmentFloors.posix 下限）' : ''}；bash ${realBash ? '真 bash' : '存根/不可用'}${realBash ? '（bash 族文件按 environmentFloors.realBash 下限）' : ''}`,
);
const floorFor = (file) => {
  if (nativeMissing && typeof envFloorsAll.nativeAbsent?.files?.[file] === 'number') {
    return { floor: envFloorsAll.nativeAbsent.files[file], tag: '无原生下限' };
  }
  if (isPosix && typeof envFloorsAll.posix?.files?.[file] === 'number') {
    return { floor: envFloorsAll.posix.files[file], tag: 'POSIX 下限' };
  }
  if (realBash && typeof envFloorsAll.realBash?.files?.[file] === 'number') {
    return { floor: envFloorsAll.realBash.files[file], tag: '真 bash 下限' };
  }
  const base = envDependent[file];
  return typeof base === 'number' ? { floor: base, tag: '宿主相关下限' } : undefined;
};

for (const [file, pct] of files) {
  const resolved = floorFor(file);
  if (resolved !== undefined) {
    // 宿主相关文件：按下限校验（低于下限才红），并如实标注是按下限过的。
    if (pct + TOLERANCE < resolved.floor) {
      regressions.push(`${file}  ${pct}%（${resolved.tag} ${resolved.floor}%）`);
    } else {
      envChecked.push(`${file}  ${pct}%（${resolved.tag} ${resolved.floor}%）`);
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

// ---- 文件清点（2026-10-11）：报告**没列到**的产物，逐文件棘轮与新增下限都看不见它们 ----
const includedFiles = listIncludedFiles();
const reportedSet = new Set(files.keys());
// 口径自证：报告里出现产物之外的文件 ⇒ include 口径与清点口径已漂移，此时"缺失"读数不可信。
const outsideReport = [...reportedSet].filter((f) => !f.startsWith('src/'));
// 纯类型模块（编译产物无可执行语句）单列：它们**不可能**出现在覆盖率报告里，属"读数无意义"而非"缺判据"。
// 与 `--dump-inventory` 分支共用同一份判定（`classifyMissingArtifacts`）——口径不许分叉。
const { missing: missingFiles, typeOnly: typeOnlyArtifacts } = classifyMissingArtifacts(
  includedFiles,
  reportedSet,
);
const inventoryRaw = existsSync(inventoryBaselinePath)
  ? JSON.parse(readFileSync(inventoryBaselinePath, 'utf8'))
  : {};
const inventoryPlatform = inventoryRaw.platforms?.[process.platform];
const inventoryNew = [];
let inventoryCleared = 0;
if (!Array.isArray(inventoryPlatform)) {
  // 该平台还没有基线：**如实报告，不假装通过**（也不可能凭空造出其它平台的文件清单）。
  console.log(
    `⚠️  ${process.platform} 没有「覆盖率文件清点」基线 ⇒ 本平台只报告不阻断：` +
      `源文件 ${includedFiles.length} 个，其中 ${missingFiles.length} 个一行都没执行过（报告里不出现）。`,
  );
  console.log(
    '    建立基线：node scripts/coverageGate.mjs --from-json <报告> --dump-inventory（首次须 --force）',
  );
} else {
  const inventorySet = new Set(inventoryPlatform);
  const missingSet = new Set(missingFiles);
  for (const f of missingFiles) if (!inventorySet.has(f)) inventoryNew.push(f);
  // 「已清偿」= 基线里登记过、本次却不再缺失：或是已进报告（补了判据），或是文件已删（减法）。
  inventoryCleared = inventoryPlatform.filter((f) => !missingSet.has(f)).length;
  console.log(
    `ℹ️  覆盖率文件清点：源文件 ${includedFiles.length} 个 ｜ 进报告 ${reportedSet.size} 个 ｜ ` +
      `一行都没执行过 ${missingFiles.length} 个（${process.platform} 基线 ${inventoryPlatform.length} ｜ ` +
      `新增 ${inventoryNew.length} ｜ 已清偿 ${inventoryCleared}${inventoryCleared > 0 ? '，可 --dump-inventory 收紧' : ''}）` +
      (typeOnlyArtifacts.length > 0
        ? `\n    （另有 ${typeOnlyArtifacts.length} 个**纯类型模块**：编译产物只剩 ` +
          '`export {};`，无可执行行 ⇒ 不可能进覆盖率报告，不计入清点基线）'
        : ''),
  );
}

if (outsideReport.length > 0) {
  console.error(
    `✗ 清点口径不一致：报告里有 ${outsideReport.length} 个文件不落在 src/ 下（例：${outsideReport
      .slice(0, 3)
      .join(', ')}）⇒ 先对齐 package.json 的 --test-coverage-include 与 listIncludedFiles()。`,
  );
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

if (inventoryNew.length > 0) {
  console.error(
    `✗ 有 ${inventoryNew.length} 个源文件**一行都没执行过**且不在清点基线里（逐文件棘轮与新增下限都看不见它们）：`,
  );
  for (const row of inventoryNew) console.error(`    ${row}`);
  console.error('  首选是给它们补判据（哪怕只是一个 import + 一次调用）；确属设计才登记：');
  console.error('    node scripts/coverageGate.mjs --from-json <报告> --dump-inventory --force');
}

if (
  regressions.length > 0 ||
  newLow.length > 0 ||
  inventoryNew.length > 0 ||
  outsideReport.length > 0
) {
  console.error(
    `  说明：本门禁按文件冻结基线（棘轮）——低于基线超过 ${DRIFT_TOLERANCE} 点即红；新增低覆盖文件即红；` +
      '新增"没进报告"的源文件即红（见 coverageInventoryBaseline.json）。',
  );
  process.exit(1);
}
console.log(
  `✓ 覆盖率达标（聚合 ${all}% ≥ ${threshold}%；${files.size} 个文件无超容差回退${
    drifted.length > 0 ? `，${drifted.length} 个在漂移容差内` : ''
  }${Array.isArray(inventoryPlatform) ? '' : '；⚠️ 本平台文件清点基线未建立，仅报告'}）`,
);
