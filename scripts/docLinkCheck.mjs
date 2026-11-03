#!/usr/bin/env node
/**
 * 文档死链检查（无第三方依赖）——把「文档里指向不存在的文件」从人工抽查变成机械可证。
 *
 * ## 为什么需要它（审计 §3.5「非 archive 文档 172 处死路径」的收口）
 *
 * 这类缺陷的形态是：文档里的**相对链接**指向已改名/已删除的文件，而没有任何门禁会报错
 * （实测过 README 写着「以 `docs/TASK_BOARD_2026-09-13.md` 为准」，而该文件**从未存在**）。
 * 手工修 172 处既易漏又不可验证，故先立门禁：**存量冻结、只增即红**——新增死链直接阻断，
 * 存量按批清偿（每清一批就把基线改小，与 `scripts/checkFuncBaseline.json` 同一纪律）。
 *
 * ## 口径
 *
 * - 扫描范围：仓库根 `*.md` + `docs/**`（**排除** `docs/archive/**`：历史档允许指向已迁走的路径）；
 * - 2026-11-03（P0 裂缝清零 T0.1）扩面：**src 树下全部 .ts 的注释**也纳入——出证工具最关键的一句
 *   「这是完整性检测，不是签名」（`auditChain.ts`）曾指向不存在的 `docs/AUDIT_ATTESTATION.md`，
 *   而 `*.md` 扫描永远看不见 `.ts` 注释里的死链。源码侧只认**反引号包住的 `docs/…` 路径**
 *   （注释文本里的保守口径，避免把示例代码刷成噪声）；
 * - 只认**相对链接目标**（`[文字](路径)`），跳过 `http(s):` / `mailto:` / 纯锚点 `#...`；
 * - 目标判定：相对链接所在文件所在目录解析；命中即通过（不做大小写/模糊匹配，避免假绿）；
 * - 反引号里的路径**不**作为链接判定（多为示例代码，如 `` `src/foo.ts` ``），避免噪声——
 *   但源码注释里的 `docs/…` 反引号提及**算**（见上）。
 *
 * 用法：
 *   node scripts/docLinkCheck.mjs              # 检查（新增死链则 exit 1）
 *   node scripts/docLinkCheck.mjs --list       # 打印全部死链（含存量）
 *   node scripts/docLinkCheck.mjs --update     # 用当前结果重写基线（清偿后手动调用）
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'docLinkBaseline.json');
const args = process.argv.slice(2);

/** 收集待扫描的 markdown 文件（排除 archive 与 node_modules/dist）。 */
function collectMarkdown(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (['node_modules', 'dist', 'archive', '.git'].includes(name)) continue;
      collectMarkdown(full, out);
      continue;
    }
    if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** 相对链接目标（跳过外链/锚点/邮箱）。 */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * 反引号里的「像真文件」的仓库相对路径。
 *
 * 口径刻意保守（否则示例代码会刷屏假阳性）：必须 ① 落在已知顶层目录下、
 * ② 带**真实文件扩展名**、③ 不含空格与通配符。示例性路径（如 `src/foo.ts`）会落到基线里，
 * 作为「已知的非指向性提及」留档；真正指向已改名/已删文件的提及则应当修掉。
 */
const KNOWN_TOP_DIRS =
  '(?:src|docs|tests|scripts|evals|benchmark|examples|resources|defaults|python|web|native|crates|assets)';
const BACKTICK_PATH_RE = new RegExp(
  '`(' + KNOWN_TOP_DIRS + '/[A-Za-z0-9_./-]+\\.(?:ts|tsx|md|json|mjs|cjs|py|rs|yml|yaml|toml|sh))`',
  'g',
);

/**
 * 源码注释里反引号包住的 `docs/…` 路径（只认 docs 顶层，不认 src/tests 等——
 * 后者在注释里几乎都是叙述性提及，扫了全是噪声；docs 引用才是「应该去读的说明」）。
 */
const SRC_DOCS_RE =
  /`(docs\/[A-Za-z0-9_./-]+\.(?:ts|tsx|md|json|mjs|cjs|py|rs|yml|yaml|toml|sh))`/g;

/**
 * 收集 `src/**` 下的 .ts 源文件（排除 .d.ts；目录排除口径与 markdown 侧一致）。
 * @param dir 起始目录。
 * @param out 累加数组。
 * @returns 文件路径列表。
 */
function collectSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (['node_modules', 'dist', 'archive', '.git'].includes(name)) continue;
      collectSources(full, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * 判断一行源码是否是**注释文本**（行注释 / JSDoc 续行 / 块注释内部）。
 *
 * 刻意保守：只认「整行是注释」的形状（trimmed 以 `//`、`*`、`/*` 开头，或已处于块注释内）。
 * 字符串字面量里出现 `//`（URL）不影响——那种行不以 `//` 开头；模板字符串里不可能出现
 * 裸反引号，所以「反引号 docs 路径」不会从字符串里误报。
 * @param line 原始行。
 * @param state 跨行状态（`inBlock` 标记块注释是否延续到下一行；本函数会就地更新它）。
 * @returns 是注释文本则为 true。
 */
function isCommentLine(line, state) {
  const trimmed = line.trim();
  if (state.inBlock) {
    if (trimmed.includes('*/')) state.inBlock = false;
    return true;
  }
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('/*')) {
    if (!trimmed.includes('*/')) state.inBlock = true;
    return true;
  }
  return false;
}

/**
 * 逐文件找出解析不到的死链（markdown 链接 + 反引号路径提及 + 源码注释里的 docs 提及）。
 *
 * 输入缺失/扫描范围塌缩一律**阻断**（2026-10-06 排查修正）：此前用 `.filter(existsSync)`
 * 静默丢文件 ⇒「README 不见了」会表现为"死链减少（已清偿）"而不是失败。
 * 源码侧的 `src/**` 缺失同样阻断（2026-11-03）：src 目录不在 = 判定面塌缩，不等于"零死链"。
 * @returns `{ dead, scanned, scannedSources }`（scanned = 实际扫描的 markdown 文件数，
 * scannedSources = 实际扫描的源码文件数，用于汇总行如实报出）。
 */
function findDeadLinks() {
  const readme = join(ROOT, 'README.md');
  if (!existsSync(readme)) {
    console.error(`✗ 缺少 ${readme}：文档死链门禁的必需输入，缺了无法判定（不等于"零死链"）。`);
    process.exit(1);
  }
  const docsDir = join(ROOT, 'docs');
  const docs = existsSync(docsDir) ? collectMarkdown(docsDir) : [];
  if (docs.length === 0) {
    console.error(
      `✗ ${docsDir} 下没扫到任何 markdown：扫描范围塌缩，按失败处理（不等于"零死链"）。`,
    );
    process.exit(1);
  }
  const srcDir = join(ROOT, 'src');
  if (!existsSync(srcDir)) {
    console.error(`✗ 缺少 ${srcDir}：源码注释死链扫描的必需输入，缺了无法判定。`);
    process.exit(1);
  }
  const sources = collectSources(srcDir);
  const files = [readme, ...docs];
  const dead = [];
  for (const file of files) {
    const relFile = relative(ROOT, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const targets = [];
      for (const m of line.matchAll(LINK_RE)) {
        const target = m[1] ?? '';
        if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;
        const clean = target.split('#')[0] ?? '';
        if (clean !== '') targets.push({ kind: 'link', target: clean });
      }
      for (const m of line.matchAll(BACKTICK_PATH_RE)) {
        if (m[1] !== undefined) targets.push({ kind: 'mention', target: m[1] });
      }
      for (const { kind, target } of targets) {
        // 两种解析都试：**文档相对**（markdown 链接的常规语义）与**仓库根相对**
        // （本仓文档大量用根相对写法提及路径，如 `defaults/cliHelp.json`）。
        // 只有两者都不存在才算死链——否则会产出大量假阳性，把门禁变成噪声。
        const docRelative = resolve(dirname(file), target);
        const rootRelative = resolve(ROOT, target);
        if (!existsSync(docRelative) && !existsSync(rootRelative)) {
          dead.push({
            key: `${kind}: ${relFile} -> ${target}`,
            file: relFile,
            line: index + 1,
            target,
          });
        }
      }
    });
  }
  // 源码注释（2026-11-03 扩面）：只扫注释行里的反引号 `docs/…` 提及。
  for (const file of sources) {
    const relFile = relative(ROOT, file).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const state = { inBlock: false };
    lines.forEach((line, index) => {
      if (!isCommentLine(line, state)) return;
      for (const m of line.matchAll(SRC_DOCS_RE)) {
        const target = m[1];
        if (target === undefined) continue;
        // 与 markdown 侧同口径：文档相对与仓库根相对都不存在才算死链。
        const docRelative = resolve(dirname(file), target);
        const rootRelative = resolve(ROOT, target);
        if (!existsSync(docRelative) && !existsSync(rootRelative)) {
          dead.push({
            key: `src-mention: ${relFile} -> ${target}`,
            file: relFile,
            line: index + 1,
            target,
          });
        }
      }
    });
  }
  return { dead, scanned: files.length, scannedSources: sources.length };
}

const { dead, scanned, scannedSources } = findDeadLinks();
/** 唯一键（同一「文件 → 目标」在多行重复时只记一次；基线按唯一键冻结）。 */
const uniqueKeys = [...new Set(dead.map((d) => d.key))].sort();
const occurrenceCount = dead.length;

if (args.includes('--list')) {
  console.log(
    `扫描 ${scanned} 份 markdown + ${scannedSources} 份源码 ｜ 死链 ${occurrenceCount} 次出现 / ${uniqueKeys.length} 处` +
      `（link = markdown 链接目标；mention = 反引号路径提及；src-mention = 源码注释里的 docs 提及）：`,
  );
  for (const entry of dead) console.log(`  ${entry.file}:${entry.line}  ${entry.key}`);
  process.exit(0);
}

if (args.includes('--update')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(uniqueKeys, null, 2)}\n`, 'utf8');
  console.log(
    `已写入基线：${relative(ROOT, BASELINE_PATH)}（${uniqueKeys.length} 处唯一死链 / ${occurrenceCount} 次出现）`,
  );
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')))
  : new Set();
const added = uniqueKeys.filter((key) => !baseline.has(key));
const fixed = [...baseline].filter((key) => !uniqueKeys.includes(key));
const newLinks = added.filter((key) => key.startsWith('link:')).length;

console.log(
  `[docLinkCheck] 扫描 ${scanned} 份 markdown + ${scannedSources} 份源码 ｜ 死链 ${occurrenceCount} 次出现 / ${uniqueKeys.length} 处` +
    `（基线 ${baseline.size} ｜ 新增 ${added.length}（其中链接 ${newLinks}）｜ 已清偿 ${fixed.length}）`,
);
if (fixed.length > 0) {
  console.log('  已清偿（请运行 --update 收紧基线）：');
  for (const key of fixed) console.log(`    ${key}`);
}
if (added.length > 0) {
  console.error('✗ 新增死链（指向不存在的文件）：');
  for (const key of added) console.error(`    ${key}`);
  console.error(
    '  修掉；确为「迁移前路径/示例」等有意保留的引用时，请说明理由后运行 --update 纳入基线。',
  );
  process.exit(1);
}
console.log('✓ 无新增死链');
