// a11y 对比度门禁（D1）：对 web/styles 做「前景 × 背景」对比度体检，按 WCAG 2.1 AA 判定。
//
// 为什么用门禁而不是人眼看一遍：
//   主题是双套（dark / light）且颜色全走 CSS 变量，改一个 token 的代价是「另一套主题下某个
//   角落变成浅灰配浅灰」。人眼只在当前主题下看不出问题，机器两套都能算。
//   实测价值：本门禁首次运行即抓到 3 处真实缺陷——命令面板 `.cmdk` 引用了不存在的 `--surface`
//   （浅色主题下退化成深底深字，1.03:1）、工作状态条 `.work-indicator` 引用了不存在的
//   `--text-dim`（2.52:1）、`.perm.danger` 无浅色覆盖（2.03:1）。
//
// 口径（务必写清，避免以后为达标改口径）：
//   · 目标：**正文文本**对比度 ≥ 4.5:1（AA 常规字号）。本项目 UI 字号集中在 11–15px，无大字号豁免。
//   · 亮度：WCAG 2.1 相对亮度（sRGB 分量先线性化：c≤0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4），
//     对比度 = (Llight+0.05)/(Ldark+0.05)。
//   · 范围：① 主题 token 之间的「文本 × 表面」组合（显式表 TOKEN_PAIRS）；
//     ② 样式表内声明了 color 的选择器（自动扫），背景按级联取：主题前缀覆盖 > 同选择器 > 基类。
//   · 级联感知：[data-theme="light"] X 视为「X 在浅色主题下的覆盖」，只在浅色主题生效；
//     否则覆盖规则会被当成独立规则误判（第一版就踩过）。
//   · 不覆盖：语法高亮 token（highlight.css）、rgba/渐变等半透明背景（无法脱离上下文解析成实色）、
//     纯装饰元素（无文本）。
//   · 另有一条独立门禁：所有 `var(--x)` 引用必须指向已定义的 token（见文件末尾），
//     专防本轮抓到的「变量名拼错 → 静默退化成深色 literal」。

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STYLE_DIR = new URL('../styles', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIN_RATIO = 4.5;

/** 主题 token 级显式组合：[前景 token, 背景 token]。 */
const TOKEN_PAIRS = [
  ['text', 'bg'],
  ['text', 'bg-elev'],
  ['text', 'panel'],
  ['text', 'panel-2'],
  ['dim', 'bg'],
  ['dim', 'bg-elev'],
  ['dim', 'panel'],
  ['dim', 'panel-2'],
  ['ok', 'bg'],
  ['err', 'bg'],
  ['warn', 'bg'],
];

/** 读一份 CSS 并剥掉注释。 */
function readCss(file) {
  return readFileSync(join(STYLE_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 解析「选择器 { 声明 }」二元组（@media 内的规则会被单独取出，属可接受的过近似）。 */
function parseRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decls = {};
    for (const part of m[2].split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      decls[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    if (selector.startsWith('@') || selector === '') continue;
    // 主题前缀 → 该规则只在该主题生效，logical 为去掉前缀后的选择器。
    const themeScoped = /^\[data-theme="(dark|light)"\]\s+(.*)$/.exec(selector);
    out.push({
      selector,
      theme: themeScoped ? themeScoped[1] : 'both',
      logical: themeScoped ? themeScoped[2] : selector,
      decls,
    });
  }
  return out;
}

/** 解析主题 token 块：返回 { dark:{}, light:{} }。 */
function parseThemes(rules) {
  const themes = { dark: {}, light: {} };
  for (const { selector, decls } of rules) {
    const target = selector.includes('data-theme="light"')
      ? themes.light
      : selector.includes('data-theme="dark"') || selector === ':root'
        ? themes.dark
        : null;
    if (!target) continue;
    for (const [k, v] of Object.entries(decls)) {
      if (k.startsWith('--')) target[k.slice(2)] = v;
    }
  }
  return themes;
}

/** #rgb / #rrggbb → [r,g,b]；不可解析返回 null。 */
function parseHex(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** 解析颜色值（含 var() 查 token）；不可无歧义解析成实色时返回 null。 */
function resolveColor(value, tokens) {
  if (value === undefined) return null;
  let v = value.trim();
  const varMatch = /^var\(\s*--([a-z0-9-]+)\s*(?:,\s*([^)]*))?\)$/i.exec(v);
  if (varMatch) {
    const token = tokens[varMatch[1]];
    if (token !== undefined) v = String(token).trim();
    else if (varMatch[2] !== undefined) v = varMatch[2].trim();
    else return null;
  }
  const hex = parseHex(v);
  if (hex) return hex;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (rgb && (rgb[4] === undefined || Number(rgb[4]) >= 1)) return [1, 2, 3].map((i) => Number(rgb[i]));
  // rgba 半透明 / 渐变 / 关键字（transparent、inherit…）一律不作为可判定背景。
  return null;
}

/** 单通道线性化。 */
function linear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度。 */
function luminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 对比度比值（≥1）。 */
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 选择器 → 基类选择器（去掉最后一个 .class 片段）；无 .class 时返回 null。 */
function baseSelector(selector) {
  const idx = selector.lastIndexOf('.');
  return idx <= 0 ? null : selector.slice(0, idx);
}

const FILES = readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'));
const ALL_RULES = FILES.flatMap((f) => parseRules(readCss(f)));
const THEMES = parseThemes(parseRules(readCss('theme.css')));

/**
 * 取某主题下「逻辑选择器」的有效声明：主题前缀覆盖优先于通用规则。
 * @param logical 去主题前缀后的选择器
 * @param themeName 'dark' | 'light'
 * @returns 合并后的声明表
 */
function effectiveDecls(logical, themeName) {
  const merged = {};
  for (const rule of ALL_RULES) {
    if (rule.logical !== logical || rule.theme === 'light' || rule.theme === 'dark') continue;
    Object.assign(merged, rule.decls);
  }
  for (const rule of ALL_RULES) {
    if (rule.logical !== logical || rule.theme !== themeName) continue;
    Object.assign(merged, rule.decls);
  }
  return merged;
}

/** 某逻辑选择器在某主题下的背景色（含向基类回退）。 */
function backgroundOf(logical, themeName) {
  let cur = logical;
  for (let depth = 0; depth < 6 && cur; depth += 1) {
    const decls = effectiveDecls(cur, themeName);
    const bg = resolveColor(decls['background-color'] ?? decls['background'], THEMES[themeName]);
    if (bg) return bg;
    cur = baseSelector(cur);
  }
  return null;
}

test('主题 token 自查：dark / light 两套都齐备且为 6 位 hex', () => {
  const required = [
    'text', 'dim', 'ok', 'err', 'warn', 'on-ok', 'on-err', 'on-danger', 'toast-ok', 'toast-err',
    'toast-ok-border', 'toast-err-border', 'bg', 'bg-elev', 'panel', 'panel-2',
  ];
  for (const [name, tokens] of Object.entries(THEMES)) {
    assert.ok(Object.keys(tokens).length > 15, `${name} 主题 token 数量异常`);
    for (const key of required) {
      assert.ok(parseHex(tokens[key]), `${name} 主题缺 token --${key}（或不是 6 位 hex）`);
    }
  }
});

test('token 级「文本 × 表面」组合全部达 AA（4.5:1）', () => {
  const failures = [];
  let checked = 0;
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const [fgKey, bgKey] of TOKEN_PAIRS) {
      const fg = parseHex(tokens[fgKey]);
      const bg = parseHex(tokens[bgKey]);
      if (!fg || !bg) continue;
      checked += 1;
      const ratio = contrast(fg, bg);
      if (ratio < MIN_RATIO) {
        failures.push(`[${themeName}] --${fgKey} on --${bgKey} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.ok(checked >= 20, `检查对数量异常偏低（${checked}），解析器可能已失效`);
  assert.deepStrictEqual(failures, [], failures.join('\n'));
});

test('样式表内 color × background 组合全部达 AA（4.5:1）', () => {
  const failures = [];
  let checked = 0;
  for (const themeName of Object.keys(THEMES)) {
    const seen = new Set();
    for (const rule of ALL_RULES) {
      if (rule.theme === 'light' || rule.theme === 'dark') continue;
      if (seen.has(rule.logical)) continue;
      seen.add(rule.logical);
      const fg = resolveColor(effectiveDecls(rule.logical, themeName)['color'], THEMES[themeName]);
      if (!fg) continue;
      const bg = backgroundOf(rule.logical, themeName);
      if (!bg) continue;
      checked += 1;
      const ratio = contrast(fg, bg);
      if (ratio < MIN_RATIO) {
        failures.push(`[${themeName}] ${rule.logical} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.ok(checked >= 25, `检查对数量异常偏低（${checked}），解析器可能已失效`);
  assert.deepStrictEqual(failures, [], failures.join('\n'));
});

test('所有 var(--x) 引用都指向已定义的 token（防变量名拼错静默退化）', () => {
  const defined = new Set();
  for (const css of FILES.map(readCss)) {
    for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  const unknown = [];
  for (const file of FILES) {
    for (const m of readCss(file).matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(m[1])) unknown.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual([...new Set(unknown)], [], '未定义的 CSS 变量引用：\n' + unknown.join('\n'));
});

test('门禁自身可信度：纯白配纯白的对比度为 1，黑白为 21', () => {
  assert.strictEqual(Number(contrast([255, 255, 255], [255, 255, 255]).toFixed(4)), 1);
  assert.strictEqual(Number(contrast([255, 255, 255], [0, 0, 0]).toFixed(2)), 21);
});
