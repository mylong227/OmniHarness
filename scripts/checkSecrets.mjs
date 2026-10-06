#!/usr/bin/env node
/**
 * 发布物零密钥门禁（无第三方依赖）——把「个人凭据不得进版本库」从纪律变成机器兜底。
 *
 * ## 为什么需要它
 *
 * 2026-09-08 的 `31878a2`（re-init from working tree）曾把含真实 DeepSeek key 的
 * `omniharness.json` 带进 git 历史并推送远端，直至 2026-09-25 全量盘点才被发现，
 * 处置代价是全史重写 + 密钥轮换。凭据分层纪律已确立：真实密钥只放**用户级**
 * `~/.omniharness/omniharness.json`（仓库树之外），本门禁确保任何形似真实密钥的
 * 内容一旦进入暂存区/版本库即提交中止——个人数据从此在机制上不可能抵达发布物。
 *
 * ## 口径
 *
 * - pre-commit 以 `--staged` 扫**暂存内容**（要提交什么就扫什么）；手动跑不带参数扫 HEAD；
 * - 只报「形似真实密钥」的高置信模式（sk- 长串 / AWS / GitHub / Slack），避免示例值假阳；
 * - 行内含 `omniharness:fake-secret` 标记的行豁免（测试夹具登记口）；
 * - 命中输出只给 文件:行号 + 模式名，**不回显密钥内容**（避免门禁自身成为泄露面）；
 * - **两层扫描**（2026-10-06 修复「二进制分类盲区」）：
 *   ① 文本层：`git grep` 扫 git 认定的文本文件（快）；
 *   ② 编码层：对 git 判为**二进制**的文件再按**编码**解码后扫描——**UTF-16LE/BE 保存的文本
 *      文件**在 git 眼里就是二进制（含 NUL），而 ASCII 正则在其字节序列里永远匹配不到
 *      （`s\0k\0-\0…`）⇒ 修复前"用 UTF-16 存一份带密钥的配置"可静默绕过本门禁。
 *      真正解析不了的二进制按 `skippedBinary` 计数并**如实打印**，不再无声无息。
 * - 汇总行**必须打印扫描面**（文件数 / 文本 / 二进制 / 解码数）：否则"扫描范围塌缩"与
 *   "真的零密钥"在输出上不可区分（同 2026-10-06 那批 fail-open 的形态）。
 *
 * 用法：
 *   node scripts/checkSecrets.mjs            # 扫 HEAD（手动体检）
 *   node scripts/checkSecrets.mjs --staged   # 扫暂存内容（pre-commit 调用）
 */
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  { re: /sk-[A-Za-z0-9]{16,}/, name: 'sk- 风格模型密钥（DeepSeek/OpenAI 兼容）' },
  { re: /AKIA[0-9A-Z]{16}/, name: 'AWS AccessKeyId' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, name: 'GitHub token' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, name: 'Slack token' },
];

/** 行内豁免标记：测试夹具里的假密钥在行尾加此注释即可通过。 */
const ALLOW_MARKER = 'omniharness:fake-secret';
/** 单个二进制文件的解码上限（超过即跳过并计数，避免把门禁变成内存炸弹）。 */
const MAX_DECODE_BYTES = 4 * 1024 * 1024;

const staged = process.argv.includes('--staged');
const rev = staged ? ':0' : 'HEAD';

/**
 * 跑 git 并返回 stdout（无命中类退出码 1 由调用方决定如何处理）。
 * @param args git 参数。
 * @param encoding 输出编码（`buffer` 时返回 Buffer）。
 * @returns stdout。
 */
function git(args, encoding = 'utf8') {
  return execFileSync('git', args, {
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 取本次要扫的文件清单（NUL 分隔 ⇒ 含空格/中文路径安全）。
 * @returns 仓库相对路径数组。
 */
function trackedFiles() {
  const args = staged
    ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']
    : ['ls-tree', '-r', '--name-only', '-z', 'HEAD'];
  return git(args)
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 取 git 认定为**文本**的文件集合（`-I` 的语义）。
 *
 * 注意：搜索目标是树（`HEAD`）时 git grep 会把每行输出前缀成 `HEAD:<path>`（`--cached` 则不带前缀）
 * ——首版没剥前缀，于是"文本集合"与真实路径**对不上**，全部文件都被当成二进制（2026-10-06 自查抓到）。
 * @returns 文本文件路径集合（仓库相对路径，无前缀）。
 */
function textFiles() {
  const scope = staged ? ['--cached'] : ['HEAD'];
  /** 树搜索时 git grep 加的前缀。 */
  const prefix = staged ? '' : 'HEAD:';
  try {
    const raw = git(['grep', '-I', '-l', '-z', '-e', '', ...scope])
      .split('\0')
      .filter(Boolean);
    return new Set(
      raw.map((p) => (prefix !== '' && p.startsWith(prefix) ? p.slice(prefix.length) : p)),
    );
  } catch (err) {
    // 空树（无文件）时 git grep 退出码 1：此时没有任何东西要扫。
    if (err.status === 1) return new Set();
    throw err;
  }
}

/**
 * 读一个文件的内容（按本次模式取暂存版或 HEAD 版；读不到返回 undefined）。
 * @param file 仓库相对路径。
 * @returns 内容 Buffer，或 undefined。
 */
function readBlob(file) {
  try {
    return git(['show', `${rev}:${file}`], 'buffer');
  } catch {
    return undefined;
  }
}

/**
 * 把可疑内容按编码解码为文本；非 UTF-16 且含 NUL 的二进制返回 undefined。
 *
 * 为什么只认 UTF-16 BOM：无 BOM 的 UTF-16 与随机二进制不可区分，猜错会把噪声当密钥报出来
 * （假阳性比漏报更容易让人把门禁关掉）。BOM 是**明确声明**，可安全解码。
 * @param buf 文件内容。
 * @returns 解码后的文本，或 undefined（视为不可解析二进制）。
 */
function decodeSuspicious(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node 无 utf16be：交换字节序后按 LE 解。
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return undefined;
}

/**
 * 扫一段文本，返回命中的 `行号 + 模式名`（豁免标记行跳过）。
 * @param text 文本内容。
 * @returns 命中列表（只带行号与模式名；**内容不回显**，避免门禁成为泄露面）。
 */
function scanText(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue;
    for (const { re, name } of PATTERNS) {
      if (re.test(line)) found.push({ line: index + 1, name });
    }
  }
  return found;
}

const all = trackedFiles();
const text = textFiles();
/** 本次要扫的文件里，git 判为文本的那些。 */
const textScanned = all.filter((f) => text.has(f));
const binary = all.filter((f) => !text.has(f));
const hits = [];
let decoded = 0;
let skippedBinary = 0;

// ---- 第 1 层：文本文件（git grep 一次扫全部，快）----
for (const { re, name } of PATTERNS) {
  let out = '';
  try {
    const scope = staged ? ['--cached'] : ['HEAD'];
    // 模式必须用 `-e` 显式给出：否则 `--cached` 会被当成 **pathspec**（git 在首个非选项参数处
    // 停止解析选项）⇒ `git grep` 直接 fatal 128（2026-10-06 自查抓到；`-e` 形式的空模式调用没这问题）。
    out = git(['grep', '-n', '-E', '-e', re.source, ...scope]);
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    if (line.includes(ALLOW_MARKER)) continue;
    // 二进制命中会打印 `Binary file <path> matches`（无内容）——fail-closed 记一笔，且不回显内容。
    hits.push({ text: line, name });
  }
}

// ---- 第 2 层：git 判为二进制的文件，按编码解码后再扫（UTF-16 文本是本次修复的靶心）----
for (const file of binary) {
  const buf = readBlob(file);
  if (buf === undefined) continue;
  if (buf.length === 0 || buf.length > MAX_DECODE_BYTES) {
    skippedBinary += 1;
    continue;
  }
  const decodedText = decodeSuspicious(buf);
  if (decodedText === undefined) {
    skippedBinary += 1;
    continue;
  }
  decoded += 1;
  for (const hit of scanText(decodedText)) {
    hits.push({ text: `${file}:${String(hit.line)}: <解码命中，内容不回显>`, name: hit.name });
  }
}

if (hits.length === 0) {
  // 范围必须如实拆开报：`--staged` 的**逐文件清单**是暂存子集，而文本层 `git grep --cached`
  // 扫的是 **index 全体**（比暂存子集更大 ⇒ 更保守），两个数字不同不能混着写（首版就混了）。
  const scopeText = staged
    ? `暂存文件 ${String(all.length)}（文本 ${String(textScanned.length)} ＋ 二进制分类 ${String(binary.length)}）` +
      ` ｜ 文本层范围 = index 全体 ${String(text.size)}`
    : `${String(all.length)} 个文件（文本 ${String(textScanned.length)} ＋ 二进制分类 ${String(binary.length)}）`;
  console.log(
    `[checkSecrets] ✓ 零密钥（扫${staged ? '暂存内容' : 'HEAD'}：${scopeText} ｜ 二进制中按编码解码 ` +
      `${String(decoded)}、不可解析跳过 ${String(skippedBinary)} ｜ 4 类高置信模式 ｜ 豁免标记 ${ALLOW_MARKER}）`,
  );
  process.exit(0);
}

console.error(`[checkSecrets] ✗ 检测到 ${hits.length} 处疑似真实密钥：`);
for (const h of hits) {
  console.error(`  ${h.text}    ← ${h.name}`);
}
console.error('个人凭据只允许放在用户级 ~/.omniharness/omniharness.json（仓库树之外）。');
console.error('若为测试假密钥，请在该行加豁免标记注释：omniharness:fake-secret');
process.exit(1);
