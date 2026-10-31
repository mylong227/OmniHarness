// 「纸与墨」唯一颜色事实源（TS 侧）：antd token 与对比度判据共用同一份 hex。
//
// ## 为什么它必须存在（ADR-0018 §4.1 / UI_LIBRARY_UPGRADE §6.1）
//
// 迁移前唯一配色事实源是 `web/styles/theme.css` 的 CSS 变量——antd 的 CSS-in-JS 吃不到它：
// ThemeConfig 里必须给 JS 字符串。若在组件里散写 hex，会出现「antd 主题改了、CSS 没跟上」
// 的双源漂移；因此规则是：
//   · 所有 antd token 从本文件取值（antdTheme.ts 不允许出现第二个 hex）；
//   · `antdTheme.test.ts` 从本文件计算 WCAG 对比度（≥4.5）；
//   · W1 起 theme.css 的同名 token 与本文件**逐值一致**（判据比对，暂允许双源过渡）。
//
// 值的来源：theme.css 2026-10-18「纸与墨」重设计定稿 + §117 的 --tip-* 三枚。
// 语义注释只写「这个颜色在界面里承担什么」，不重复 theme.css 的设计叙事。

export type ThemeName = 'light' | 'dark';

/** 一套主题的全部颜色（与 theme.css 的同名 token 逐值对应）。 */
export interface Palette {
  /** 表面阶梯：页面底 → 后退一档（左右栏）→ 卡片 → 卡片悬停 → 选中底 → 代码块底 */
  bg: string;
  bgElev: string;
  panel: string;
  panel2: string;
  panelSel: string;
  codeBg: string;
  /** 描边三档：栏内分隔 / 容器边缘 / 控件边界（≥3:1，承担 WCAG 1.4.11） */
  hairline: string;
  borderSoft: string;
  border: string;
  borderStrong: string;
  /** 文本：正文 / 次要 / 装饰 */
  text: string;
  dim: string;
  faint: string;
  /** 签名色「靛墨」：主行动 / 当前项 / 链接 / 焦点，全站唯一品牌色 */
  accent: string;
  /** 按下 / hover 的加深档 */
  accent2: string;
  /** 实心靛墨底上的前景字 */
  inkFg: string;
  /** 语义色：低饱和、只做信号不做装饰 */
  ok: string;
  err: string;
  warn: string;
  info: string;
  /** 悬浮提示（白气泡口径：浅色纯白 / 深色墨片） */
  tipBg: string;
  tipFg: string;
  tipLine: string;
  /** 浮起两层阴影：接触阴影 + 环境阴影（只给菜单/模态/toast） */
  shadow1: string;
  shadow2: string;
}

export const DARK: Palette = {
  bg: '#17191c',
  bgElev: '#121417',
  panel: '#1e2126',
  panel2: '#282c32',
  panelSel: '#343a43',
  codeBg: '#101215',

  hairline: '#262b31',
  borderSoft: '#353b43',
  border: '#6b7480',
  borderStrong: '#8b95a3',

  text: '#eceef2',
  dim: '#aab2bd',
  faint: '#8d96a2',

  accent: '#a8b4e8',
  accent2: '#c2cbf1',
  inkFg: '#14161c',

  ok: '#8fbf9f',
  err: '#e89a92',
  warn: '#d4b06a',
  info: '#9fb3d9',

  tipBg: '#282c32',
  tipFg: '#eceef2',
  tipLine: '#353b43',

  shadow1: '0 1px 2px rgba(0, 0, 0, 0.34), 0 6px 16px rgba(0, 0, 0, 0.3)',
  shadow2: '0 2px 6px rgba(0, 0, 0, 0.4), 0 24px 56px rgba(0, 0, 0, 0.55)',
};

export const LIGHT: Palette = {
  bg: '#f8f7f4',
  bgElev: '#f1f0ec',
  panel: '#fdfcf9',
  panel2: '#e9e8e3',
  panelSel: '#dde2e7',
  codeBg: '#f4f4f2',

  hairline: '#e4e4e0',
  borderSoft: '#d5d6d1',
  border: '#7d838c',
  borderStrong: '#5d646d',

  text: '#1a1d21',
  dim: '#565d66',
  faint: '#5f666f',

  accent: '#3d4a86',
  accent2: '#2f3a6e',
  inkFg: '#fdfcf9',

  ok: '#3a7150',
  err: '#a6362f',
  warn: '#7d5a1c',
  info: '#3f5680',

  tipBg: '#ffffff',
  tipFg: '#1a1d21',
  tipLine: '#d5d6d1',

  shadow1: '0 1px 2px rgba(38, 40, 46, 0.06), 0 6px 16px rgba(38, 40, 46, 0.08)',
  shadow2: '0 2px 6px rgba(38, 40, 46, 0.08), 0 24px 56px rgba(38, 40, 46, 0.14)',
};

/** 按主题名取调色板。 */
export function paletteOf(theme: ThemeName): Palette {
  return theme === 'light' ? LIGHT : DARK;
}

/**
 * 主题色方案（2026-10-31，用户口径：多套主题色、设置里可切、明暗双主题都要有）。
 *
 * 方案只换**签名色族三件套**（accent / accent2 / inkFg）——表面阶梯与语义色是全站共用的
 * 骨架，不随方案变（否则 5 方案 × 2 主题 = 10 份全量调色板，改一处表面色要动十处）。
 * `ink`（靛墨）是默认方案，值与 DARK / LIGHT 的同名 token 逐值一致——theme.css 的
 * 基础块就是它，`<html>` 上没有 `data-scheme` 属性即等于 ink。
 * CSS 侧的同名镜像在 theme.css 的 `[data-theme][data-scheme]` 块，两处由
 * `themeSchemes.test.ts` 静态比对防漂移。
 */
export type ThemeScheme = 'ink' | 'moss' | 'plum' | 'amber' | 'rose' | 'graphite';

/** 一套方案的签名三色（映射到 theme.css 的 --accent / --accent-2 / --ink-fg）。 */
export interface SchemeColors {
  /** 签名色：主行动 / 当前项 / 链接 / 焦点。 */
  accent: string;
  /** 按下 / hover 的邻档（dark 下是提亮档，light 下是压暗档）。 */
  accent2: string;
  /** 实心签名底上的前景字。 */
  inkFg: string;
}

/** 五套方案 × 明暗的签名三色（全部对 bg/panel 过 WCAG AA ≥4.5，判据逐对复核）。 */
export const SCHEMES: Record<ThemeScheme, { dark: SchemeColors; light: SchemeColors }> = {
  ink: {
    dark: { accent: '#a8b4e8', accent2: '#c2cbf1', inkFg: '#14161c' },
    light: { accent: '#3d4a86', accent2: '#2f3a6e', inkFg: '#fdfcf9' },
  },
  moss: {
    dark: { accent: '#9ed0b6', accent2: '#b8dfd0', inkFg: '#0f1f18' },
    light: { accent: '#2e6b4f', accent2: '#245540', inkFg: '#fdfcf9' },
  },
  plum: {
    dark: { accent: '#c9a8e0', accent2: '#dcc4ee', inkFg: '#180f20' },
    light: { accent: '#6d3a91', accent2: '#572d75', inkFg: '#fdfcf9' },
  },
  amber: {
    dark: { accent: '#e0bf8f', accent2: '#ecd2ac', inkFg: '#1f1608' },
    light: { accent: '#8a5a14', accent2: '#6e470f', inkFg: '#fdfcf9' },
  },
  rose: {
    dark: { accent: '#e0a3b8', accent2: '#ecbdd0', inkFg: '#200f14' },
    light: { accent: '#a83a5e', accent2: '#8a2e4c', inkFg: '#fdfcf9' },
  },
  graphite: {
    // 石墨（黑白灰）：「纸与墨」最原始的中性签名——暗色下是浅灰墨、亮色下是石墨深灰，
    // 无色相（通道差 0，天然通过 colorSystem 的中性容差）。
    dark: { accent: '#cdd3da', accent2: '#dee2e8', inkFg: '#16181c' },
    light: { accent: '#3a3f45', accent2: '#24282d', inkFg: '#fdfcf9' },
  },
};
