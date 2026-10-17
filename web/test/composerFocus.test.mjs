// 判据：输入区的**焦点可见性归谁**，以及"框里不再套框"这条外观契约。
//
// 为什么需要它（2026-10-17 的教训）：
//   输入区的焦点信号在一天内被搬了三次，每次都是"用户看图才发现"，而且我前两轮在
//   `minimal.css` 的注释里都写了「判据：web/test/a11yKeyboard.test.mjs」—— **那句是假的**，
//   那个文件里根本没有 focus/outline 断言（已核实：grep 无命中）。也就是说：
//     · 焦点可见性（WCAG 2.4.7）当时**零覆盖**；
//     · 而这条契约正是我反复改动、并且差点把信号彻底删掉的地方。
//   所以补上它。断言方式是解析 CSS 源（与 a11yContrast.test.mjs 同源做法），
//   因为这几条性质本身就是"样式表里写了什么"，不需要真浏览器。
//
// 契约（三条，全部来自用户反馈与无障碍要求）：
//   ① textarea **不出任何描边**（含聚焦）—— 它躺在一块有圆角有表面的面板里，
//      再叠一圈就是"框里套框"（用户连续两次反馈的那件事）。
//   ② 焦点信号**由容器承担**：`.composer-box:focus-within` 必须给出可见描边。
//   ③ 该描边与面板底色的对比度 ≥ 3:1（WCAG 2.2 2.4.13 Focus Appearance 的门槛）。
//
// 变更这里之前先读 `web/styles/minimal.css` §6 的三次校正记录。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STYLE_DIR = new URL('../styles', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CSS = readFileSync(join(STYLE_DIR, 'minimal.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 取一条规则的声明块（**精确**选择器，取最后一条匹配即级联胜出者）。
 *
 * 为什么必须精确匹配而不是前缀匹配：`.composer` 是 `.composer-box` / `.composer:hover`
 * 的前缀，前缀匹配会逮到别的规则（本文件第一版就因此在 ④⑤ 上假红）——
 * 那是判据的缺陷，不是样式的缺陷。
 * @param selector 精确选择器文本（如 `.composer-box`）
 * @param extra 允许的额外选择器片段（如 `:focus-within`），命中其一即可
 * @returns 声明文本与完整选择器；未找到时 null
 */
function declsOf(selector, extra = []) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('([^{}]*)\\{(?:[^{}]*)\\}', 'g');
  const wanted = [selector, ...extra.map((e) => selector + e)];
  let last = null;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (wanted.some((w) => selectors.includes(w))) last = { selector: m[1].trim(), decls: m[0] };
  }
  return last;
}

test('① 输入区 textarea 不出描边（含聚焦）——防"框里套框"回归', () => {
  const rule = declsOf('.composer textarea', [':focus', ':focus-visible']);
  assert.ok(rule !== null, 'minimal.css 必须有 .composer textarea 的显式规则');
  assert.match(rule.decls, /outline:\s*none/, 'textarea 不得有 outline（那是内层框的来源）');
  assert.match(rule.decls, /box-shadow:\s*none/, 'textarea 不得有 box-shadow 描边');
  // 该规则的选择器必须覆盖 :focus / :focus-visible，否则聚焦瞬间又会冒出一圈。
  assert.match(rule.selector, /:focus\b/, '规则必须显式覆盖 :focus');
  assert.match(rule.selector, /:focus-visible/, '规则必须显式覆盖 :focus-visible');
});

test('② 焦点信号由容器承担：.composer-box:focus-within 必须有可见描边', () => {
  const rule = declsOf('.composer-box:hover', [':focus-within']);
  assert.ok(rule !== null, 'minimal.css 必须有 .composer-box:hover / :focus-within 规则');
  assert.match(rule.selector, /:focus-within/, '该规则必须同时管 :focus-within');
  assert.match(
    rule.decls,
    /border-color:\s*var\(--border-strong\)/,
    '容器在聚焦时必须把描边换成可见色（键盘用户的唯一焦点信号）',
  );
  // 反面对照：若这里写成 transparent（把信号删掉），上一条断言就变红。
  assert.ok(
    !/border-color:\s*transparent/.test(rule.decls),
    '容器聚焦描边不得为 transparent（那等于没有焦点信号）',
  );
});

test('③ 焦点描边的对比度 ≥3:1（两套主题，WCAG 2.2 2.4.13）', () => {
  /**
   * 读主题 token 值（跨全部样式表，后者覆盖前者 = 级联同序）。
   *
   * 选择器形式的坑：`theme.css` 里是 `:root,\n[data-theme='dark'] {`——**跨行**且带多个选择器。
   * 第一版只匹配 `[data-theme='dark']` 紧贴 `{` 的写法，于是 dark 块一个 token 都读不到，
   * 判据 ③ 因此假红（是判据的错，不是样式的错）。这里放宽到"选择器段里含主题名"。
   * @param theme 'dark' | 'light'
   * @returns token 表
   */
  function themeTokens(theme) {
    const out = {};
    for (const f of readdirSync(STYLE_DIR).filter((x) => x.endsWith('.css'))) {
      const text = readFileSync(join(STYLE_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        if (!m[1].includes(theme)) continue;
        for (const part of m[2].split(';')) {
          const i = part.indexOf(':');
          if (i < 0) continue;
          const key = part.slice(0, i).trim();
          if (!key.startsWith('--')) continue;
          out[key.replace(/^--/, '')] = part.slice(i + 1).trim();
        }
      }
    }
    return out;
  }
  /** #rrggbb → [r,g,b]。 */
  function hex(v) {
    const h = String(v).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(h);
    return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
  }
  /** 相对亮度。 */
  function lum([r, g, b]) {
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  /** 对比度。 */
  function ratio(a, b) {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  }
  for (const theme of ['dark', 'light']) {
    const t = themeTokens(theme);
    const fg = hex(t['border-strong']);
    const bg = hex(t['panel']);
    assert.ok(fg !== null && bg !== null, `${theme} 主题必须有 --border-strong 与 --panel`);
    const r = ratio(fg, bg);
    assert.ok(
      r >= 3,
      `${theme}：焦点描边 --border-strong 对 --panel 只有 ${r.toFixed(2)}:1（要求 ≥3:1）`,
    );
  }
});

test('④ 输入面板是可见的圆润表面（否则"加大圆角"不可见——这是踩过的坑）', () => {
  const rule = declsOf('.composer-box');
  assert.ok(rule !== null, 'minimal.css 必须有 .composer-box 规则');
  assert.match(
    rule.decls,
    /background:\s*var\(--panel\)/,
    'composer-box 必须有可见表面：透明背景 + 大圆角 = 圆角看不见（2026-10-17 实际踩过）',
  );
  const radius = /border-radius:\s*(\d+)px/.exec(rule.decls);
  assert.ok(radius !== null, 'composer-box 的圆角必须是显式像素值（标尺里的 12px 偏"方正"）');
  assert.ok(
    Number(radius[1]) >= 18,
    `composer-box 圆角 ${radius[1]}px 偏小；用户反馈"太方正"后定在 22px`,
  );
});

test('⑤ 输入区自带的那圈框必须去掉（.composer 不再画整框）', () => {
  // 历史上这里有一条 `border-top: 1px solid var(--hairline)`，配合 border-radius:0
  // 形成"直角外框套圆角内框"，正是用户两次反馈要修的东西。
  const rule = declsOf('.composer');
  assert.ok(rule !== null, 'minimal.css 必须有 .composer 规则');
  assert.ok(
    !/border-top:\s*1px solid var\(--hairline\)/.test(rule.decls),
    '.composer 不得再画顶部发丝线（会形成直角外框）',
  );
  assert.match(rule.decls, /border-top:\s*none/, '.composer 的整框必须显式清零');
});

test('⑥ 样式表引用的 token 都存在（防"描边写成不存在的变量 ⇒ 静默退化"）', () => {
  const files = readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'));
  const defined = new Set();
  for (const f of files) {
    const c = readFileSync(join(STYLE_DIR, f), 'utf8');
    for (const m of c.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  for (const token of ['--panel', '--border-strong', '--hairline']) {
    assert.ok(defined.has(token), `本判据依赖的 ${token} 必须已定义`);
  }
});
