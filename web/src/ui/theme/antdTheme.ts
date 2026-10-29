// antd ThemeConfig 工厂：把 palette.ts 的 hex 映射成 light/dark 两套 antd token。
//
// ## 口径（ADR-0018 §4「Ant 骨架 + 纸与墨皮肤」）
//
//   · **本文件不得出现主题色字面 hex**——颜色一律取自 paletteOf(theme)；
//     `#000000` / `#ffffff` 是 mixHex 的混合锚点（结构用量，非新色相），W1 的字面量扫描只白名单这两个。
//   · 圆角 / 密度 / 字号是**两套主题共享**的常量（纸与墨是同一套语言的两种光照）。
//   · 组件级覆盖只列会「露馅」的（默认观感与纸与墨冲突处），见 UI_LIBRARY_UPGRADE §4.2。
//
// ## 为什么两套主题都走 defaultAlgorithm（W0 实测结论，别"用回 darkAlgorithm"）
//
// darkAlgorithm 会把五个语义 seed **强制压暗**（实测 colorPrimary #a8b4e8 → #929cc8），
// 且映射发生在 seed 层：显式传 token.colorPrimary 救不回来、嵌套 ConfigProvider 会继承算法、
// 反解 seed 色相/饱和度漂移——四条路全堵死（W0 全部实测过）。它同时也会重派生中性面，
// 让表面阶梯脱离 palette。
// 因此：**两套主题同走 defaultAlgorithm（seed 即 map，身份保留）+ 中性面全量显式覆盖**。
// 我们本来就拥有整套表面阶梯（theme.css 2026-10-18 定稿），antd 只是消费方；
// 「算法派生」的价值（自动换肤）在本项目不存在需求，契约优先。dark 下的语义 hover/active
// 用显式 map token 给出提亮档（浅色下 antd 默认压暗方向正确，不需要）。

// 子路径导入（同 ThemeProvider 的口径）；ThemeConfig 是纯类型导入，esbuild 整句擦除。
import antdThemeAlgorithm from 'antd/es/theme';
import type { ThemeConfig } from 'antd';
import { paletteOf, type Palette, type ThemeName } from './palette.ts';

/** 紧凑 IDE 密度（对照旧 UI：控件 32、表格 small、菜单行 34）。 */
export const DENSITY = {
  borderRadius: 10,
  borderRadiusLG: 14,
  borderRadiusSM: 8,
  controlHeight: 32,
  controlHeightSM: 28,
  controlHeightLG: 38,
  fontSize: 14,
  lineHeight: 1.6,
} as const;

/** 正文字体族：与 theme.css 的 body 字体逐字一致（两套皮肤必须同一副字）。 */
export const FONT_FAMILY =
  "system-ui, 'Segoe UI', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** mixHex 的混合锚点（结构用量，非主题色；见文件头说明）。 */
const MIX_BLACK = '#000000';
const MIX_WHITE = '#ffffff';

/**
 * 两色线性插值（sRGB 逐通道）；t=0 返回 a，t=1 返回 b。
 * 只用于从 palette 推导 hover/fill 等邻档，不引入新色相。
 */
export function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return (
    '#' +
    pa
      .map((c, i) => Math.round(c * (1 - t) + pb[i] * t))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * 中性面覆盖：把 theme.css 的表面阶梯翻译成 antd 的 surface/border/text/fill token。
 * 两套主题共用同一份键清单，值来自各自的 palette——「同名 token 两套语义一致」由此保证。
 */
function neutralTokens(p: Palette, dark: boolean): Record<string, string> {
  // 悬浮层：--hover 是 rgba(text, .055) 的覆盖层，antd 的 fill 是实色——
  // 用「panel 向 text 混合」得到等效实色，方向与主题一致。
  const fillHover = mixHex(p.panel, p.text, 0.06);
  const fillHoverStrong = mixHex(p.panel, p.text, 0.1);
  const fillActive = mixHex(p.panel, p.text, 0.15);
  return {
    // 表面阶梯：页面底 / 卡片与输入 / 浮层（菜单、下拉、弹出卡）
    colorBgLayout: p.bg,
    colorBgContainer: p.panel,
    colorBgElevated: p.panel,
    // 描边三档：控件边界（≥3:1）/ 容器边缘 / 栏内分隔
    colorBorder: p.border,
    colorBorderSecondary: p.borderSoft,
    colorSplit: p.hairline,
    // 文本：正文 / 次要 / 装饰
    colorText: p.text,
    colorTextSecondary: p.dim,
    colorTextTertiary: p.faint,
    colorTextQuaternary: p.faint,
    // 实心底（主按钮、开关 on 态）上的文字：用墨/纸前景，不用白
    colorTextLightSolid: p.inkFg,
    // 悬浮填充四档（弱 → 强）
    colorFillQuaternary: fillHover,
    colorFillTertiary: fillHoverStrong,
    colorFillSecondary: fillHoverStrong,
    colorFill: fillActive,
    // 下拉/列表选中底与悬浮底
    controlItemBgHover: fillHoverStrong,
    controlItemBgActive: p.panelSel,
    controlItemBgActiveHover: mixHex(p.panelSel, p.text, 0.08),
    // 遮罩：暗色沿用审批模态现有口径，浅色取同一黑的弱档
    colorBgMask: dark ? 'rgba(10, 12, 16, 0.62)' : 'rgba(38, 40, 46, 0.32)',
  };
}

/** dark 下语义族 hover/active 提亮/压暗档（浅色交给 antd 默认压暗方向，链接两主题都钉 info）。 */
function semanticHoverTokens(p: Palette, dark: boolean): Record<string, string> {
  if (!dark) return { colorLink: p.info };
  return {
    colorPrimaryHover: p.accent2,
    colorPrimaryActive: mixHex(p.accent, MIX_BLACK, 0.16),
    colorSuccessHover: mixHex(p.ok, MIX_WHITE, 0.16),
    colorSuccessActive: mixHex(p.ok, MIX_BLACK, 0.16),
    colorWarningHover: mixHex(p.warn, MIX_WHITE, 0.16),
    colorWarningActive: mixHex(p.warn, MIX_BLACK, 0.16),
    colorErrorHover: mixHex(p.err, MIX_WHITE, 0.16),
    colorErrorActive: mixHex(p.err, MIX_BLACK, 0.16),
    colorInfoHover: mixHex(p.info, MIX_WHITE, 0.16),
    colorInfoActive: mixHex(p.info, MIX_BLACK, 0.16),
    // 链接跟随 info（antd 默认蓝会从 colorInfo 缺省值漏出来）
    colorLink: p.info,
    colorLinkHover: mixHex(p.info, MIX_WHITE, 0.16),
  };
}

/** 语义 seed + 中性面 + hover/active → antd token（ThemeConfig.token）。 */
function seedTokens(p: Palette, dark: boolean): NonNullable<ThemeConfig['token']> {
  return {
    // 语义 seed（五族 + 基底）
    colorPrimary: p.accent,
    colorSuccess: p.ok,
    colorWarning: p.warn,
    colorError: p.err,
    colorInfo: p.info,
    colorBgBase: p.bg,
    colorTextBase: p.text,
    ...neutralTokens(p, dark),
    ...semanticHoverTokens(p, dark),

    borderRadius: DENSITY.borderRadius,
    borderRadiusLG: DENSITY.borderRadiusLG,
    borderRadiusSM: DENSITY.borderRadiusSM,
    controlHeight: DENSITY.controlHeight,
    controlHeightSM: DENSITY.controlHeightSM,
    controlHeightLG: DENSITY.controlHeightLG,
    fontSize: DENSITY.fontSize,
    lineHeight: DENSITY.lineHeight,
    fontFamily: FONT_FAMILY,

    boxShadow: p.shadow1,
    boxShadowSecondary: p.shadow2,
  };
}

/** 组件级覆盖：只列默认观感会与纸与墨「露馅」冲突的组件。 */
function componentTokens(p: Palette): NonNullable<ThemeConfig['components']> {
  return {
    Button: {
      // 纸面不投影：按钮的层级靠边线与填充，不靠阴影。
      defaultShadow: 'none',
      primaryShadow: 'none',
      fontWeight: 500,
      paddingInline: 14,
    },
    Card: {
      headerBg: 'transparent',
      paddingLG: 16,
      boxShadowTertiary: 'none',
    },
    Menu: {
      itemHeight: 34,
      itemBorderRadius: 8,
      itemMarginInline: 4,
      itemBg: 'transparent',
    },
    Table: {
      headerBg: p.panel2,
      headerSplitColor: 'transparent',
      cellPaddingBlockSM: 6,
    },
    Tabs: {
      horizontalItemPadding: '10px 0',
      titleFontSize: 14,
    },
    Modal: {
      contentBg: p.panel,
      headerBg: p.panel,
    },
    Tooltip: {
      // 2026-10-28 定稿的「白气泡」口径：浅色纯白 / 深色墨片，深字不反相。
      colorBgSpotlight: p.tipBg,
      colorTextLightSolid: p.tipFg,
      borderRadius: 10,
    },
    Layout: {
      siderBg: p.bgElev,
      headerBg: p.bgElev,
      bodyBg: p.bg,
    },
  };
}

/**
 * 按主题构造 antd ThemeConfig（唯一装配点；ThemeProvider 消费）。
 * @param theme 主题名
 * @returns 可直接传给 ConfigProvider 的 ThemeConfig
 */
export function antdThemeOf(theme: ThemeName): ThemeConfig {
  const p = paletteOf(theme);
  return {
    // **两套主题同走 default**：seed 即 map，杜绝 darkAlgorithm 的语义压暗（见文件头）。
    algorithm: antdThemeAlgorithm.defaultAlgorithm,
    // CSS 变量模式显式开启（v6 类型是 { prefix, key } 对象——布尔形态已被移除；W0 实测
    // 默认**关闭**，不开就没有 --ant-* 变量，antd.css 与判据都拿不到运行时 token）。
    cssVar: { prefix: 'ant' },
    // hashed 关掉：类名稳定（.ant-btn 不带 hash 尾巴），判据与覆盖 CSS 都好写。
    hashed: false,
    token: seedTokens(p, theme === 'dark'),
    components: componentTokens(p),
  };
}
