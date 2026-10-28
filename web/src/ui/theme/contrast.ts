// WCAG 2.1 对比度纯函数：palette.ts 的伴生工具。
//
// 消费方：antdTheme.test.ts（W1 判据：seed/组件 token 配对 ≥4.5:1）与 W0 PoC 的暗色对比度结论。
// 只做 sRGB 相对亮度 + 对比比值的教科书算法，不引入色彩管理。

import { paletteOf, type ThemeName } from './palette.ts';

/** #rgb/#rrggbb → [r,g,b]；非法输入返回 null（判据用它 fail-closed）。 */
export function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** sRGB 通道 → 线性值（WCAG 公式：c/12.92 或 ((c+0.055)/1.055)^2.4）。 */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度（0=黑，1=白）。 */
export function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) return null;
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1–21）；任一输入非法返回 null。 */
export function contrastRatio(fgHex: string, bgHex: string): number | null {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  if (l1 === null || l2 === null) return null;
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 正文关键配对清单：每项都是「会出现在真实界面上的字/底组合」。
 * antdTheme.test.ts 逐项断言 ≥4.5（AA 正文）；indicates='large' 的项 ≥3:1（AA 大字号/图形）。
 */
export interface ContrastPair {
  /** 语义描述（判据失败信息用） */
  label: string;
  fg: string;
  bg: string;
  /** 大字号/非文本可放宽到 3:1 */
  minimum: 3 | 4.5;
}

/** 按主题生成关键配对（含 antd 承担的高频面：按钮/菜单/表格/输入）。 */
export function contrastPairsOf(theme: ThemeName): ContrastPair[] {
  const p = paletteOf(theme);
  return [
    { label: '正文 on 页面底', fg: p.text, bg: p.bg, minimum: 4.5 },
    { label: '正文 on 卡片', fg: p.text, bg: p.panel, minimum: 4.5 },
    { label: '正文 on 卡片悬停', fg: p.text, bg: p.panel2, minimum: 4.5 },
    { label: '次要文本 on 页面底', fg: p.dim, bg: p.bg, minimum: 4.5 },
    { label: '次要文本 on 卡片', fg: p.dim, bg: p.panel, minimum: 4.5 },
    { label: '靛墨强调字 on 页面底', fg: p.accent, bg: p.bg, minimum: 4.5 },
    { label: '靛墨强调字 on 卡片', fg: p.accent, bg: p.panel, minimum: 4.5 },
    { label: '主按钮字 on 靛墨底', fg: p.inkFg, bg: p.accent, minimum: 4.5 },
    { label: '成功字 on 页面底', fg: p.ok, bg: p.bg, minimum: 4.5 },
    { label: '错误字 on 页面底', fg: p.err, bg: p.bg, minimum: 4.5 },
    { label: '告警字 on 卡片', fg: p.warn, bg: p.panel, minimum: 4.5 },
    { label: '信息字 on 卡片', fg: p.info, bg: p.panel, minimum: 4.5 },
    { label: '提示字 on 气泡底', fg: p.tipFg, bg: p.tipBg, minimum: 4.5 },
    { label: '控件边线 on 卡片（非文本 3:1）', fg: p.border, bg: p.panel, minimum: 3 },
  ];
}
