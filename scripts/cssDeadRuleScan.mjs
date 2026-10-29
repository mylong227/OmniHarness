// 临时工具（W5 验收后删除）：扫描 web/styles/*.css 中的死规则并按 --write 删除。
//
// 判活口径（保守优先，宁漏删不误删）：
//   · 语料 = web/src/**/*.{ts,tsx} + web/index.html + web/test/**/*.{ts,tsx} 的全文；
//   · 类名 token 在语料中出现 → 活；
//   · token 的前两段（act-kind-user → act-kind）在语料中出现 → 活（动态拼接：'act-kind-' + type）；
//   · ant- / hljs / katex 前缀 → 活（库运行时生成）；
//   · 选择器无类名（元素/:root/#id 纯伪类）→ 活；
//   · 选择器带属性选择器 [..] → 活（保守）；
//   · @keyframes/@font-face/@import → 活；
//   · @media/@supports 外层仅在**全部内层死透**时整块删除。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const STYLE_DIR = join(ROOT, 'web', 'styles');

/** 语料：所有可能引用类名的源码文本。 */
function buildCorpus() {
  const parts = [];
  const walk = (dir, exts) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = join(dir, name);
      try {
        const stat = readdirSync(full);
        walk(full, exts);
        void stat;
      } catch {
        if (exts.some((e) => name.endsWith(e))) parts.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(join(ROOT, 'web', 'src'), ['.ts', '.tsx']);
  walk(join(ROOT, 'web', 'test'), ['.ts', '.tsx']);
  parts.push(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'));
  return parts.join('\n');
}

const corpus = buildCorpus();

/**
 * 从 from 起找下一个「注释外」的字符（跳过块注释与引号串）。
 * @param {string} text 全文
 * @param {number} from 起点
 * @param {string} ch 目标字符
 * @returns {number} 命中下标（-1 = 无）
 */
function findOutside(text, from, ch) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*' + '/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === String.fromCharCode(39) || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === ch) return i;
    i += 1;
  }
  return -1;
}

/**
 * 从 from（已停在 '{'）找配对的 '}'（跳过注释/字符串）。
 * @param {string} text 全文
 * @param {number} open 左括号下标
 * @returns {number} 右括号下标（-1 = 无）
 */
function matchBrace(text, open) {
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*' + '/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === String.fromCharCode(39) || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? i - 1 : -1;
}
const ALWAYS_ALIVE = /^(ant-|hljs|katex|md-|is-)/; // is-*：JS 切换的状态类族（TodoDock `is-${status}` 实证）

/**
 * 类名 token 是否存活。
 * @param {string} token 类名（不含点）
 * @returns {boolean}
 */
function aliveToken(token) {
  if (token.length < 4) return true; // 超短泛化名（ok/err/add…）保守保留
  if (ALWAYS_ALIVE.test(token)) return true;
  if (corpus.includes(token)) return true;
  const segs = token.split('-');
  if (segs.length >= 2 && corpus.includes(segs.slice(0, 2).join('-'))) return true; // 动态拼接前缀
  return false;
}

/**
 * 解析一段 CSS（可含嵌套 @块）为节点数组。
 * @param {string} css 文本
 * @returns {{sel: string, body: string}[]}
 */
function parseRules(css) {
  const nodes = [];
  let i = 0;
  while (i < css.length) {
    const brace = findOutside(css, i, '{');
    if (brace < 0) break;
    const close = matchBrace(css, brace);
    if (close < 0) break;
    nodes.push({ sel: css.slice(i, brace).trim(), body: css.slice(brace + 1, close) });
    i = close + 1;
  }
  return nodes;
}

/** 提取选择器里的类名 token。 */
function classTokens(sel) {
  return [...sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/**
 * 规则是否存活（含 @media 递归）。
 *
 * 多选择器规则**按逗号拆分逐个判活**：任一选择器活 ⇒ 整条保留（保守——只删
 * "所有选择器都死透"的规则）；单个选择器内是复合条件（同一元素同时带这些类），
 * 用 every 语义。这样 `.brand .logo, .brand .brand-mark` 这类混合规则不会误删活的一半。
 * @param {{sel: string, body: string}} node 规则
 * @returns {boolean}
 */
function isAlive(node) {
  const sel = node.sel.replace(/\/\*[\s\S]*?\*\//g, ''); // 挂在规则前的注释不参与判活
  if (/^@(keyframes|font-face|import|charset|layer|property)/.test(sel)) return true;
  if (/^@(media|supports)/.test(sel)) {
    const inner = parseRules(node.body);
    return inner.some(isAlive);
  }
  const selectors = sel
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (selectors.length === 0) return true;
  return selectors.some((one) => {
    if (one.includes('[')) return true; // 属性选择器保守保留
    const tokens = classTokens(one);
    if (tokens.length === 0) return true; // 元素/:root/#id 规则
    // 混排选择器（.hljs-title.function_ / .foo .ant-bar）：任一 token 属库运行时生成即活
    if (tokens.some((t) => ALWAYS_ALIVE.test(t))) return true;
    return tokens.every(aliveToken);
  });
}

/** 处理单个文件，返回 {text, dead}。 */
function processFile(text) {
  let dead = 0;
  const out = [];
  let i = 0;
  const n = text.length;
  // 逐块重建：节点之间的原始间隙（空行/注释）保留；死节点整段删除。
  // 注意必须用注释感知扫描（findOutside/matchBrace）：注释里可能出现花括号
  //（如「`.composer textarea:focus{outline:none}` 等仍原样保留」），朴素计数会把边界切进注释里。
  while (i < n) {
    const brace = findOutside(text, i, '{');
    if (brace < 0) {
      out.push(text.slice(i));
      break;
    }
    const close = matchBrace(text, brace);
    if (close < 0) {
      out.push(text.slice(i));
      break;
    }
    const sel = text.slice(i, brace).trim();
    const full = text.slice(i, close + 1);
    const node = { sel, body: text.slice(brace + 1, close) };
    if (isAlive(node)) {
      out.push(full);
    } else {
      dead += 1;
      // 吞掉节点前紧邻的一个空行，避免留双空行
      const last = out.length - 1;
      if (last >= 0 && /\n\s*$/.test(out[last])) out[last] = out[last].replace(/\n\s*$/, '\n');
    }
    i = close + 1;
  }
  return { text: out.join(''), dead };
}

const args = process.argv.slice(2);
const write = args.includes('--write');
let totalDead = 0;
for (const file of readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'))) {
  const full = join(STYLE_DIR, file);
  const src = readFileSync(full, 'utf8');
  const { text, dead } = processFile(src);
  const linesBefore = src.split('\n').length;
  const linesAfter = text.split('\n').length;
  totalDead += dead;
  if (dead > 0) {
    console.log(
      `${file}: ${String(dead)} 条死规则，${String(linesBefore)} → ${String(linesAfter)} 行`,
    );
    if (write) writeFileSync(full, text);
  }
}
console.log(
  write
    ? `--write 完成，共删 ${String(totalDead)} 条`
    : `共发现 ${String(totalDead)} 条死规则（--write 应用）`,
);
