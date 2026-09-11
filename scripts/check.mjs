#!/usr/bin/env node
// OmniHarness 项目铁律静态自检（自身零依赖，仅用 node: 内置）。
// 不依赖任何 npm 包，可被 CI 直接调用：发现违规即退出码 1。
//
// 依赖政策（2026-09-05 起，见 docs/DEPENDENCY_POLICY.md）：
//   **必要即可依赖** —— 能实质提升能力的优质依赖即资产；但必须「准入登记 + 分层隔离」。
//   src/ports/** 与 src/core/** 恒为第三方-free，依赖只能落在适配层，保证可换、架构不塌。
//
// 校验项：
//   1) 依赖准入清单：package.json 的 dependencies 每项须登记于 dependency-allowlist.json。
//   2) 依赖登记字段完整：reason/capability/license/approvedAt/layer 缺一即阻断。
//   3) 依赖许可证合规：仅允许 permissive（拒绝 GPL/AGPL/SSPL/BUSL 等）。
//   4) 第三方导入须准入：src/** 的第三方裸导入须在 allowlist 内。
//   5) 核心与端口层零第三方：src/ports/**、src/core/** 禁止第三方导入（阻断）。
//   6) TS 文件名 camelCase：src/**/*.ts 基名须匹配 ^[a-z][a-zA-Z0-9]*$。
//   7) 文件行数上限：src 单文件不得 > MAX_FILE_LINES。
//   8) 函数体行数上限：src 函数/方法/箭头体不得 > MAX_FUNC_LINES（启发式大括号匹配）。
//   9) 体积预算 / 传递依赖收敛 / 未使用依赖（报告级，--strict 时升级阻断）。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
// 2026-09-12 决策（D1，见 docs/REFACTOR_BOARD_2026-09-12.md）：上限 400 → 800。
// 理由：架构稳定优先于机械拆文件；歧义职责靠「解耦/目录归属/注释」治，不靠切行数。
const MAX_FILE_LINES = 800;
const MAX_FUNC_LINES = 80;

// 阻断级（铁律，零容忍）：exit 1。报告级（既有债务，默认仅提示）：`--strict` 时升级为阻断。
const STRICT = process.argv.includes('--strict');
const blockingRules = new Set([
  '依赖准入清单',
  '依赖登记字段完整',
  '依赖许可证合规',
  '第三方导入须准入',
  '核心与端口层零第三方',
  'TS 文件名 camelCase',
]);

// ---- 依赖准入清单（必要即可依赖；未登记即阻断）----
const ALLOWLIST_PATH = join(ROOT, 'dependency-allowlist.json');
function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch {
    // 清单缺失本身即阻断：没有清单就无法判定任何依赖是否合规。
    add('依赖准入清单', 'dependency-allowlist.json', '清单文件缺失或不可解析，无法判定依赖合规性');
    return null;
  }
}
// 初始化在 add() 定义之后执行（loadAllowlist 依赖其副作用），见下方 ADMISSION 段。

// Node 内置模块裸名（允许不带 node: 前缀的导入，二者等价）。
const NODE_BUILTINS = new Set([
  'assert',
  'assert/strict',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'vm',
  'worker_threads',
  'zlib',
  'module',
  'console',
]);

const violations = [];
const depReport = { count: 0 };
const importedPkgs = new Set(); // 全量扫完后用于「未使用的已装依赖」报告
function add(rule, where, detail) {
  violations.push({ rule, where, detail });
}

// ---- ADMISSION 段：依赖准入（必须在 add() 之后初始化）----
const allowlistDoc = loadAllowlist();
const allowlist = allowlistDoc?.allowlist ?? {};
const allowedLicenses = new Set(allowlistDoc?.allowedLicenses ?? []);
const forbiddenLayers = (allowlistDoc?.forbiddenLayers ?? ['src/ports', 'src/core']).map((p) =>
  p.replace(/\/$/, ''),
);
const defaultBudgets = allowlistDoc?.defaultBudgets ?? {
  maxInstallKb: 2048,
  maxTransitiveDeps: 20,
};

/** 从裸导入说明符解析出包名（支持 `pkg` / `@scope/pkg` / `pkg/sub/path`）。 */
function pkgNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** 该文件所在层（相对仓库根的路径，POSIX 分隔）。 */
function layerOf(file) {
  return file
    .slice(ROOT.length + 1)
    .split('\\')
    .join('/');
}

/** 该层是否被禁止引入第三方。 */
function isForbiddenLayer(file) {
  const rel = layerOf(file);
  return forbiddenLayers.some((p) => rel === p || rel.startsWith(p + '/'));
}

// ---- 1) 依赖准入清单 + 字段完整 + 许可证合规 ----
function checkDependencyAdmission() {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = pkg.dependencies ?? {};
  const names = Object.keys(deps);

  if (names.length === 0) {
    depReport.count = 0;
    return;
  }
  depReport.count = names.length;

  for (const name of names) {
    const entry = allowlist[name];
    if (entry === undefined || entry === null) {
      add(
        '依赖准入清单',
        `package.json#dependencies.${name}`,
        `未登记于 dependency-allowlist.json。必要即可依赖——但须先按 docs/DEPENDENCY_POLICY.md §2 写明理由后登记`,
      );
      continue;
    }
    // 字段完整：缺一即无法说明「为什么值得引入」。
    for (const field of ['reason', 'capability', 'license', 'approvedAt', 'layer']) {
      const v = entry[field];
      if (typeof v !== 'string' || v.trim() === '') {
        add('依赖登记字段完整', `dependency-allowlist.json#${name}`, `缺少必填字段 '${field}'`);
      }
    }
    // 许可证合规：permissive 白名单外一律阻断（防传染性/商用限制污染 Apache-2.0 主项目）。
    const lic = typeof entry.license === 'string' ? entry.license : '';
    if (lic !== '' && allowedLicenses.size > 0 && !allowedLicenses.has(lic)) {
      add('依赖许可证合规', `dependency-allowlist.json#${name}`, `许可证 '${lic}' 不在许可集合内`);
    }
    // 声明的落点层不得是被禁止的核心/端口层。
    const declaredLayer = typeof entry.layer === 'string' ? entry.layer.replace(/\/$/, '') : '';
    if (
      declaredLayer !== '' &&
      forbiddenLayers.some((p) => declaredLayer === p || declaredLayer.startsWith(p + '/'))
    ) {
      add(
        '核心与端口层零第三方',
        `dependency-allowlist.json#${name}`,
        `声明的落点层 '${declaredLayer}' 属禁止引入第三方的层`,
      );
    }
  }
}

// ---- 2) 依赖体积预算 / 传递依赖收敛（报告级，node_modules 存在时才可实测）----
function checkDependencySize() {
  for (const name of Object.keys(allowlist)) {
    const dir = join(ROOT, 'node_modules', ...name.split('/'));
    const pkgJsonPath = join(dir, 'package.json');
    let installed = null;
    try {
      installed = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue; // 未安装则跳过实测（CI install 后自动生效）
    }
    const entry = allowlist[name];
    const maxKb = entry?.maxInstallKb ?? defaultBudgets.maxInstallKb;
    const kb = dirSizeKb(dir);
    if (kb > maxKb) {
      add('依赖体积预算', `node_modules/${name}`, `install 体积 ${kb} KB > 预算 ${maxKb} KB`);
    }
    const transitive = Object.keys(installed.dependencies ?? {}).length;
    const maxT = entry?.maxTransitiveDeps ?? defaultBudgets.maxTransitiveDeps;
    if (transitive > maxT) {
      add('依赖传递收敛', `node_modules/${name}`, `传递依赖 ${transitive} 个 > 上限 ${maxT}`);
    }
  }
}

/** 目录体积（KB，递归，容错跳过不可读项）。 */
function dirSizeKb(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* 忽略不可读文件 */
        }
      }
    }
  }
  return Math.round(total / 1024);
}

// ---- 遍历 src ----
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

// ---- 准入制第三方导入检查：适配层须登记，核心/端口层一律禁止 ----
function checkImports(file, src) {
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    const isRelative = spec.startsWith('.') || spec.startsWith('/');
    const isNodeBuiltin = spec.startsWith('node:') || NODE_BUILTINS.has(spec);
    if (isRelative || isNodeBuiltin) continue; // 相对路径 / node: 内置一律放行

    const pkg = pkgNameOf(spec);

    // 核心 / 端口层：无论是否在 allowlist，第三方绝对禁止（架构不塌的底线）。
    if (isForbiddenLayer(file)) {
      add(
        '核心与端口层零第三方',
        file,
        `禁止第三方导入的层内引入第三方包 '${pkg}'（spec '${spec}'）`,
      );
      continue;
    }

    // 适配层：第三方须已在 allowlist 登记，否则阻断（exit 1）。
    if (!allowlist[pkg]) {
      add(
        '第三方导入须准入',
        file,
        `第三方包 '${pkg}'（spec '${spec}'）未在 dependency-allowlist.json 登记`,
      );
      continue;
    }
    importedPkgs.add(pkg);
  }
}

// ---- 9) 未使用的已装依赖（报告级）：登记且安装但 src 无导入 ----
function checkUnusedDependencies() {
  const pkgPath = join(ROOT, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return;
  }
  const depNames = new Set(Object.keys(pkg.dependencies ?? {}));
  for (const name of Object.keys(allowlist)) {
    if (!depNames.has(name)) continue; // 只评估真正安装进 dependencies 的项
    if (!importedPkgs.has(name)) {
      add(
        '未使用的已装依赖',
        `dependency-allowlist.json#${name}`,
        `已登记且已安装，但 src/** 未见任何导入（可清理，或导入被改名/改层）`,
      );
    }
  }
}

function checkFilename(file) {
  const base = basename(file, extname(file));
  if (!/^[a-z][a-zA-Z0-9]*$/.test(base)) {
    add('TS 文件名 camelCase', file, `基名 '${base}' 不符合 ^[a-z][a-zA-Z0-9]*$`);
  }
}

function checkFileLength(file, src) {
  const lines = src.split('\n').length;
  if (lines > MAX_FILE_LINES) {
    add('文件行数上限', file, `${lines} 行 > 上限 ${MAX_FILE_LINES}`);
  }
}

// 函数起点（开括号在同行的既有情况）。
function isFuncStart(line) {
  return (
    /function\s/.test(line) ||
    /=>\s*\{/.test(line) ||
    /^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(line) ||
    /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(line)
  );
}

// 仅签名、开括号在下一行（braces-on-next-line 写法）。用于堵盲区：
//   function foo()\n  {      async method()\n  {      const x = () =>\n  {
function isFuncSignatureOnly(line) {
  return (
    /^\s*(?:export\s+|async\s+)?function\s+[A-Za-z_$]/.test(line) ||
    /=>\s*$/.test(line) ||
    /^\s*(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|get\s+|set\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*$/.test(
      line,
    )
  );
}

// 向下（跳过空行/纯注释）最多 lookahead 行找首个开括号；找不到返回 null。
function findOpenBrace(lines, fromLine, lookahead) {
  for (let k = fromLine; k < Math.min(fromLine + lookahead, lines.length); k++) {
    const t = lines[k].trim();
    if (t === '' || t.startsWith('//') || t.startsWith('/*')) continue;
    const idx = lines[k].indexOf('{');
    if (idx >= 0) return { line: k, col: idx + 1 };
  }
  return null;
}

// 启发式：定位开括号（同行或下一行），匹配到闭合 `}` 测跨度。
function checkLargeFunctions(file, src) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isStart = isFuncStart(line) || isFuncSignatureOnly(line);
    if (!isStart) continue;

    let braceLine = -1;
    let col = 0;
    const sameLineOpen = line.indexOf('{');
    if (sameLineOpen >= 0) {
      braceLine = i;
      col = sameLineOpen + 1;
    } else {
      // 开括号在下一行：箭头体收窄到 2 行（避免误挂后续无关块）；其余 3 行。
      const arrow = /=>\s*$/.test(line);
      const found = findOpenBrace(lines, i + 1, arrow ? 2 : 3);
      if (!found) continue; // 无块体（如表达式体箭头），跳过
      braceLine = found.line;
      col = found.col;
    }

    let depth = 1;
    let j = braceLine;
    for (; j < lines.length; j++) {
      const text = j === braceLine ? lines[j].slice(col) : lines[j];
      for (const ch of text) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth === 0) break;
      }
      if (depth === 0) break;
    }
    const span = j - i + 1;
    if (span > MAX_FUNC_LINES) {
      add('函数体行数上限', `${file}:${i + 1}`, `约 ${span} 行 > 上限 ${MAX_FUNC_LINES}`);
    }
  }
}

function main() {
  checkDependencyAdmission(); // 1) 依赖准入 / 字段完整 / 许可证 / 落点层
  checkDependencySize(); // 2) 体积预算 / 传递收敛（实测级，缺失 node_modules 时自动跳过）
  const files = walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    checkImports(f, src); // 3) 第三方导入准入 + 核心/端口层零第三方
    checkFilename(f);
    checkFileLength(f, src);
    checkLargeFunctions(f, src);
  }
  checkUnusedDependencies(); // 4) 未使用的已装依赖（报告级）

  if (violations.length === 0) {
    console.log(`✅ 铁律自检通过：扫描 ${files.length} 个 TS 文件，零违规。`);
    process.exit(0);
  }

  // 区分阻断级与报告级：阻断级铁律恒阻断；报告级仅在 --strict 时升级为阻断。
  const isBlocking = (v) => blockingRules.has(v.rule) || STRICT;
  const blocking = violations.filter(isBlocking);
  const advisory = violations.filter((v) => !isBlocking(v));
  const hasBlocking = blocking.length > 0;

  if (advisory.length > 0) {
    console.error(
      `⚠️  技术债务（报告级，不阻断${STRICT ? '（--strict 已升级为阻断）' : ''}）：${advisory.length} 处\n`,
    );
    const byRule = {};
    for (const v of advisory) (byRule[v.rule] ??= []).push(v);
    for (const [rule, list] of Object.entries(byRule)) {
      console.error(`【${rule}】(${list.length})`);
      for (const v of list) console.error(`  - ${v.where}: ${v.detail}`);
    }
  }
  if (hasBlocking) {
    console.error(`\n❌ 铁律阻断：发现 ${blocking.length} 处违规，exit 1\n`);
    const byRule = {};
    for (const v of blocking) (byRule[v.rule] ??= []).push(v);
    for (const [rule, list] of Object.entries(byRule)) {
      console.error(`【${rule}】(${list.length})`);
      for (const v of list) console.error(`  - ${v.where}: ${v.detail}`);
    }
    process.exit(1);
  }
  console.log(`\n✅ 阻断级铁律全部通过（扫描 ${files.length} 个 TS 文件）；报告级债务见上。`);
  process.exit(0);
}

main();
