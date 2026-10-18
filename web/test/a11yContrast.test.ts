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
//   · 另有两条独立门禁：① 所有 `var(--x)` 引用必须指向已定义的 token（防「变量名拼错 → 静默
//     退化成深色 literal」）；② `.md-content` 必须显式声明 `white-space:normal`（防继承宿主
//     `.content` 的 `pre-wrap`，把 markdown 块间/末尾换行渲染成实打实的空行——2026-09-19 实测
//     单段回复容器高度 46px＝2 行，正常应为 1 行 ≈23px）。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STYLE_DIR = new URL('../styles', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIN_RATIO = 4.5;

/** 解析出的单条 CSS 规则。 */
interface CssRule {
  /** 原始选择器（含主题前缀）。 */
  selector: string;
  /** 作用主题：仅 dark / 仅 light / 两者皆可。 */
  theme: 'dark' | 'light' | 'both';
  /** 去掉主题前缀后的逻辑选择器。 */
  logical: string;
  /** 声明表：属性名 → 值。 */
  decls: Record<string, string>;
}

/** 一套主题的 token 表（token 名 → 原始 CSS 值）。 */
type ThemeTokens = Record<string, string>;

/** 两套主题的 token 表合集。 */
type ThemeMap = { dark: ThemeTokens; light: ThemeTokens };

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
  // 打磨体系新增的语义色：品牌强调与 diff 增删（现居 tokens.css）。
  // 为什么必须进这张表：它们才是"真正被当成文字用"的颜色——brand 用于链接与选中态标签、
  // add/del 用于 diff 行的 `+`/`-` 内容。只测 --ok/--err 会漏掉它们（曾靠这条才发现要单列）。
  ['brand', 'bg'],
  ['brand', 'panel'],
  ['brand', 'panel-2'],
  ['add', 'bg'],
  ['add', 'panel'],
  ['del', 'bg'],
  ['del', 'panel'],
  ['info', 'bg'],
  ['info', 'panel'],
];

/** 读一份 CSS 并剥掉注释。 */
function readCss(file: string): string {
  return readFileSync(join(STYLE_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 解析「选择器 { 声明 }」二元组（@media 内的规则会被单独取出，属可接受的过近似）。 */
function parseRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decls: Record<string, string> = {};
    for (const part of m[2].split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      decls[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    if (selector.startsWith('@') || selector === '') continue;
    // 主题前缀 → 该规则只在该主题生效，logical 为去掉前缀后的选择器。
    // 引号口径同 parseThemes：单/双引号等价，不再写死双引号（否则单引号写的主题覆盖
    // 会被当成"通用规则"，把浅色专用色拿去算深色对比度 ⇒ 假红）。
    const themeScoped = /^\[data-theme=['"]?(dark|light)['"]?\]\s+(.*)$/.exec(selector);
    out.push({
      selector,
      // 正则捕获组只可能匹配 dark / light，收窄为字面量联合。
      theme: themeScoped ? (themeScoped[1] as 'dark' | 'light') : 'both',
      logical: themeScoped ? themeScoped[2] : selector,
      decls,
    });
  }
  return out;
}

/**
 * 解析主题 token 块：返回 { dark:{}, light:{} }。
 *
 * 引号口径（2026-10 修复）：选择器一律按 `data-theme=light` 判**主题名**，不再写死双引号。
 * 为什么必须修：CSS 里 `[data-theme='light']`（单引号）与 `[data-theme="light"]`（双引号）
 * 完全等价，而原实现只认双引号 ⇒ 单引号写法的新样式表会被**静默**归进 dark（light 表反而为空）。
 * 这不是放宽口径：主题判定更准了，检查的门槛（4.5:1）与范围都没变；加 `:root` 与主题名的
 * 同时出现（`:root, [data-theme='dark']`）也照旧归 dark——与浏览器"暗色为默认"一致。
 * @param rules parseRules 的产物
 * @returns 两套主题的 token 表
 */
function parseThemes(rules: CssRule[]): ThemeMap {
  const themes: ThemeMap = { dark: {}, light: {} };
  for (const { selector, decls } of rules) {
    const isLight = /data-theme\s*=\s*['"]?light['"]?/.test(selector);
    const isDark = /data-theme\s*=\s*['"]?dark['"]?/.test(selector);
    const target = isLight ? themes.light : isDark || selector === ':root' ? themes.dark : null;
    if (!target) continue;
    for (const [k, v] of Object.entries(decls)) {
      if (k.startsWith('--')) target[k.slice(2)] = v;
    }
  }
  return themes;
}

/** #rgb / #rrggbb → [r,g,b]；不可解析返回 null。 */
function parseHex(value: unknown): number[] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** 解析颜色值（含 var() 查 token）；不可无歧义解析成实色时返回 null。 */
function resolveColor(value: string | undefined, tokens: ThemeTokens): number[] | null {
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
function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度。 */
function luminance([r, g, b]: number[]): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 对比度比值（≥1）。 */
function contrast(fg: number[], bg: number[]): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 选择器 → 基类选择器（去掉最后一个 .class 片段）；无 .class 时返回 null。 */
function baseSelector(selector: string): string | null {
  const idx = selector.lastIndexOf('.');
  return idx <= 0 ? null : selector.slice(0, idx);
}

/**
 * 样式表清单与顺序：从 **`src/main.ts` 的 import 语句**解析——import 顺序 = 打包后级联顺序。
 *
 * 为什么不再从 index.html 的 `<link>` 解析（2026-10-17 第二轮标准化）：
 *   样式已改为在入口 `src/main.ts` 里 `import '../styles/*.css'`（标准 Vite 做法，
 *   由 Vite 打包成单条 `assets/*.css` 并在产物 HTML 注入一条 `<link>`）。
 *   于是"加载顺序"的事实源从 HTML 移到了 `main.ts` 的 import 顺序 —— 判据跟着搬，
 *   断言内容（顺序正确 + 无孤儿文件）一个字没改。
 *
 * 为什么不能用 readdirSync 的字母序：同名 token / 同选择器规则都是「后者胜」，
 * 2026-10-16 起 CSS 按功能拆成多份文件，字母序 ≠ 级联序（如 polish-shell 在 refine-* 之前、
 * minimal 最后），按字母序合并会算出与浏览器不同的"有效声明"。
 *
 * 顺带把「styles/ 下的 .css 必须全部被入口 import」钉成契约——防止
 * "文件写了忘了 import"的静默失效（此前对应的是"忘了挂 <link>"）。
 */
const ENTRY_TS = readFileSync(join(STYLE_DIR, '..', 'src', 'main.ts'), 'utf8');
const LINKED_FILES = [
  ...ENTRY_TS.matchAll(/import\s+['"]\.\.\/styles\/([^'"]+?)\.css['"]/g),
].map((m) => `${m[1]}.css`);
const DISK_FILES = readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'));
const FILES = LINKED_FILES.filter((f) => DISK_FILES.includes(f));
const ALL_RULES = FILES.flatMap((f) => parseRules(readCss(f)));
/**
 * 主题 token 表：按 `main.ts` 的 import 顺序合并**全部**样式表的 token 块。
 *
 * 为什么是全部文件而不是写死清单：token 自 2026-10-16 起分散在 theme.css（基础）与
 * tokens.css（语义/动效追加层）等多份文件；写死清单必然随拆分漂移（写 ['theme.css',
 * 'polish.css'] 的旧版就因此对 polish2 的表面阶梯覆盖视而不见）。
 * 合并是"后者补前者"语义：同名 token 以加载更晚的文件为准，与浏览器级联一致。
 */
const THEMES: ThemeMap = (() => {
  const merged: ThemeMap = { dark: {}, light: {} };
  for (const file of FILES) {
    const parsed = parseThemes(parseRules(readCss(file)));
    Object.assign(merged.dark, parsed.dark);
    Object.assign(merged.light, parsed.light);
  }
  return merged;
})();

/**
 * **已折叠退役**的样式表（2026-10-18）：9 个 `polish-*` / `refine-*` 先按加载相位合并进
 * `legacy-a` / `legacy-b`，随后这两层也**原位并入** `base.css` / `shell.css` 并从入口移除
 *（并入位置 = 原加载位置，计算样式全量快照 diff 为 0）——磁盘上都不应再被 import。
 *
 * 为什么要有这个名单而不是直接靠"文件不存在"：本机有外部工具把**已删除的已跟踪文件**
 * 从 HEAD 还原回磁盘（`web/vendor/` 实测过）。还原回来的文件是**旧内容的副本**，
 * 若某天又被 import，它们会与并入段形成双份规则、打乱级联——所以这里同时做两件事：
 *   ① 容忍它们"存在但未 import"（不把还原误报成孤儿）；
 *   ② 断言它们**不得**出现在 import 列表里（还原不能悄悄回到级联中）。
 */
const RETIRED_STYLES = [
  'polish-shell.css',
  'polish-chat.css',
  'polish-composer.css',
  'polish-panels.css',
  'refine-surfaces.css',
  'refine-rhythm.css',
  'refine-overlays.css',
  'refine-native.css',
  'refine-density.css',
  'legacy-a.css',
  'legacy-b.css',
];

test('styles/ 下的 .css 必须全部被入口 main.ts import（防"文件在、没被引用"的静默失效）', () => {
  const orphan = DISK_FILES.filter((f) => !LINKED_FILES.includes(f) && !RETIRED_STYLES.includes(f));
  assert.deepStrictEqual(
    orphan,
    [],
    '未被入口 main.ts import 的孤儿样式表（若确属弃用请删除文件，不要留尸）：\n' + orphan.join('\n'),
  );
  const resurrected = RETIRED_STYLES.filter((f) => LINKED_FILES.includes(f));
  assert.deepStrictEqual(
    resurrected,
    [],
    '已折叠的旧样式表不得再被 import（会与 base/shell 里的并入段形成双份规则、打乱级联）：\n' +
      resurrected.join('\n'),
  );
  assert.ok(FILES.length >= 10, `样式表数量异常（${FILES.length}），main.ts 解析可能失效`);
});

/**
 * 取某主题下「逻辑选择器」的有效声明：主题前缀覆盖优先于通用规则。
 * @param logical 去主题前缀后的选择器
 * @param themeName 'dark' | 'light'
 * @returns 合并后的声明表
 */
function effectiveDecls(logical: string, themeName: string): Record<string, string> {
  const merged: Record<string, string> = {};
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
function backgroundOf(logical: string, themeName: string): number[] | null {
  let cur: string | null = logical;
  for (let depth = 0; depth < 6 && cur; depth += 1) {
    const decls = effectiveDecls(cur, themeName);
    // THEMES 的键恒为 dark / light 两个（构造处写死），按索引收窄。
    const bg = resolveColor(decls['background-color'] ?? decls['background'], THEMES[themeName as 'dark' | 'light']);
    if (bg) return bg;
    cur = baseSelector(cur);
  }
  return null;
}

test('主题 token 自查：dark / light 两套都齐备且为 6 位 hex', () => {
  const required = [
    'text', 'dim', 'ok', 'err', 'warn', 'on-ok', 'on-err', 'on-danger', 'toast-ok', 'toast-err',
    'toast-ok-border', 'toast-err-border', 'bg', 'bg-elev', 'panel', 'panel-2',
    // 打磨体系新增的语义色（现居 web/styles/tokens.css 的主题块）。
    'brand', 'add', 'del', 'info',
  ];
  for (const [name, tokens] of Object.entries(THEMES)) {
    assert.ok(Object.keys(tokens).length > 15, `${name} 主题 token 数量异常`);
    for (const key of required) {
      assert.ok(parseHex(tokens[key]), `${name} 主题缺 token --${key}（或不是 6 位 hex）`);
    }
  }
});

test('token 级「文本 × 表面」组合全部达 AA（4.5:1）', () => {
  const failures: string[] = [];
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
  const failures: string[] = [];
  let checked = 0;
  for (const themeName of Object.keys(THEMES)) {
    const seen = new Set<string>();
    for (const rule of ALL_RULES) {
      if (rule.theme === 'light' || rule.theme === 'dark') continue;
      if (seen.has(rule.logical)) continue;
      seen.add(rule.logical);
      // THEMES 的键恒为 dark / light 两个（构造处写死），按索引收窄。
      const fg = resolveColor(effectiveDecls(rule.logical, themeName)['color'], THEMES[themeName as 'dark' | 'light']);
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
  const defined = new Set<string>();
  for (const css of FILES.map(readCss)) {
    for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  const unknown: string[] = [];
  for (const file of FILES) {
    for (const m of readCss(file).matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(m[1])) unknown.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual([...new Set(unknown)], [], '未定义的 CSS 变量引用：\n' + unknown.join('\n'));
});

test('markdown 容器不得继承宿主容器的 pre-wrap（防块间换行被渲染成空行）', () => {
  // 背景（2026-09-19）：`white-space` 是**继承**属性。`.content`（助手卡片正文容器）为**旧纯文本
  // 渲染器**保留了 `white-space:pre-wrap`；而 markdown 管线的产物是 HTML 结构，markdown-it 在块与块
  // 之间（以及整篇末尾）本来就会写换行。若 `.md-content` 不重置，就继承 pre-wrap，那些换行各自
  // 生成一个匿名行盒 ⇒ 每个块间隙多出一整行空白（实测单段回复高度 46px＝2 行，正常应为 1 行）。
  // 本条把「必须显式 normal」与「宿主必须保留 pre-wrap」双向钉住，避免任一侧被顺手改掉。
  for (const themeName of Object.keys(THEMES)) {
    const ws = effectiveDecls('.md-content', themeName)['white-space'];
    assert.strictEqual(
      ws,
      'normal',
      `.md-content 在 ${themeName} 主题下必须显式 white-space:normal（当前：${ws ?? '未声明'}）`,
    );
  }
  assert.strictEqual(
    effectiveDecls('.content', 'dark')['white-space'],
    'pre-wrap',
    '宿主 .content 必须继续为旧纯文本渲染器保留 white-space:pre-wrap',
  );
});

test('门禁自身可信度：纯白配纯白的对比度为 1，黑白为 21', () => {
  assert.strictEqual(Number(contrast([255, 255, 255], [255, 255, 255]).toFixed(4)), 1);
  assert.strictEqual(Number(contrast([255, 255, 255], [0, 0, 0]).toFixed(2)), 21);
});
