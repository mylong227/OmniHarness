// i18n 词条完整性门禁（纯静态扫描，零浏览器依赖）：
//
// 判据一：web/src 源码里每个 `t('…')` / `t("…")` **字面量键**都必须能在 en 词条分片
//         （web/src/ui/i18n/en/*.ts）里找到同键条目——缺词条时 en 语言会静默回落中文，
//         靠人眼发现不了，这里用扫描兜底。
// 判据二：跨分片键不得重复（分片会被 en/index.ts 展开合并成一张表，重复键后者覆盖前者，
//         属静默丢翻译）。
//
// 已知边界（不扫描、由评审保证）：动态键 t(variable)（StarterTasks / PanelRegistry /
// PermissionTierModel / buildCommands 拼接键）——这些键的值无法静态枚举，靠「值与分片逐字
// 一致」的约定 + code review。
//
// 直跑：node --test web/test/i18nCoverage.test.mjs（无需构建）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const EN_DIR = fileURLToPath(new URL('../src/ui/i18n/en/', import.meta.url));

/** 递归收集目录下全部 .ts/.tsx 文件（跳过 i18n 词条目录自身）。 */
function collectTsFiles(dir, skipDirs = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (skipDirs.includes(full)) continue;
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full, skipDirs));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * 从源码文本提取 t('…') / t("…") 的字面量键。
 * 匹配面排除成员/标识符调用（.t( / xt( 不算），只认独立标识符 t(。
 * @param text 源码文本
 * @returns 键数组（保留源码里的转义写法，与分片里的写法逐字对比）
 */
function extractTLiteralKeys(text) {
  const keys = [];
  const re = /(?:^|[^\w$.])t\(\s*('((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    keys.push(m[2] !== undefined ? m[2] : m[3]);
  }
  return keys;
}

/** 分片文本里是否存在该键的条目形态（`'key':` 或裸 CJK 标识 `key:`）。 */
function chunkHasEntry(chunkText, rawKey) {
  const esc = rawKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp("(?:^|\\n)\\s*(?:'" + esc + "'|\"" + esc + '")\\s*:');
  if (quoted.test(chunkText)) return true;
  if (/^[\p{L}\p{N}_]+$/u.test(rawKey)) {
    return new RegExp('(?:^|\\n)\\s*' + esc + '\\s*:', 'm').test(chunkText);
  }
  return false;
}

/** 从分片文本收集键值对（分片是纯对象字面量 + 行注释，条目形态即 `键: '值'`，值允许换行缩进）。 */
function collectChunkEntries(chunkText) {
  const entries = [];
  const re =
    /(?:^|\n)\s*(?:'((?:[^'\\\n]|\\.)*)'|([\p{L}\p{N}_]+))\s*:\s*\n?\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  let m;
  while ((m = re.exec(chunkText)) !== null) {
    entries.push({
      key: m[1] !== undefined ? m[1] : m[2],
      value: m[3] !== undefined ? m[3] : m[4],
    });
  }
  return entries;
}

/**
 * 剥离注释与字符串字面量里的干扰（行/块注释清空；字符串原样保留供正则匹配）。
 * 轻量状态机：不追求完整 TS 词法（正则字面量等边角会造成漏检方向的误差，可接受），只保证
 * 注释里的示例调用（如 `t('已保存')`）不产生假红。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 'code';
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        out += ' ';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        out += ' ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'squote' : c === '"' ? 'dquote' : 'template';
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') {
        mode = 'code';
        out += ' ';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((mode === 'squote' && c === "'") || (mode === 'dquote' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

test('源码里每个 t() 字面量键都在 en 词条分片中有条目', () => {
  const files = collectTsFiles(SRC_ROOT, [EN_DIR.replace(/[\\/]+$/, '')]);
  const chunkFiles = collectTsFiles(EN_DIR);
  const chunks = chunkFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
  const missing = [];
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const key of extractTLiteralKeys(text)) {
      const hit = chunks.some((c) => chunkHasEntry(c.text, key));
      if (!hit) missing.push(file.replace(SRC_ROOT, '') + ' → ' + key);
    }
  }
  assert.deepEqual(missing, [], '以下 t() 键缺英文词条（补进 web/src/ui/i18n/en/ 对应分片）');
});

test('en 词条分片之间的重复键不得有相异的译文（合并时后者覆盖前者会静默换翻译）', () => {
  const chunkFiles = collectTsFiles(EN_DIR);
  const seen = new Map();
  const conflicts = [];
  for (const f of chunkFiles) {
    for (const { key, value } of collectChunkEntries(readFileSync(f, 'utf8'))) {
      if (seen.has(key)) {
        if (seen.get(key).value !== value) {
          conflicts.push(key + '：' + seen.get(key).file + '="' + seen.get(key).value + '" vs ' + f + '="' + value + '"');
        }
      } else seen.set(key, { file: f, value });
    }
  }
  assert.deepEqual(conflicts, [], '跨分片同键不同译文（统一成一个分片或对齐译文）');
});
