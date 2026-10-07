// 图标集：**自研线性 SVG**（24×24 视框、currentColor 描边、零网络依赖）。
//
// 为什么必须自研而不是引第三方图标包：
//   · 本仓铁律「离线可用、零网络依赖」——CDN 图标字体/精灵图直接排除；
//   · 零打包器（web/index.html 直接跑 tsc 产物）⇒ 没有 bundler 帮忙按需内联，引整包就是几千行死重；
//   · 图标是**视觉一致性的最大单点**：同一套圆角、同一线宽、同一 24px 网格，界面才显得"是一个东西"。
//
// 为什么不用 emoji（原先全站 100+ 处 emoji 当图标）：
//   · emoji 的字形由系统字体决定 ⇒ Windows / macOS / 各浏览器长得都不一样，跨平台不可控；
//   · 尺寸与基线不受控（18px emoji 的视觉重量 ≠ 18px 图标），对齐全靠手调；
//   · 彩色 emoji 在单色工具型界面里是"花花绿绿的小贴纸"，直接破坏克制的层级；
//   · emoji 无法跟随 `currentColor` ⇒ hover / 选中态无法与文字一起变色。
//
// 契约：所有图标都是**装饰性**的 —— 根节点固定 `aria-hidden="true"` + `focusable="false"`，
// 可读名字一律由外层容器（按钮 `aria-label` / 文案）提供。故按钮上的图标不会污染 a11y 名字。
// 判据：web/test/a11yKeyboard.test.mjs（NavRail 9 项、每个纯图标按钮都有 aria-label）。

import { React } from '../deps.js';

/** 图标名（新增图标时同步加到这里，拼错即编译期报错）。 */
export type IconName =
  | 'plus'
  | 'mic'
  | 'paperclip'
  | 'brain'
  | 'flame'
  | 'sliders'
  | 'chart'
  | 'shield'
  | 'menu'
  | 'gear'
  | 'command'
  | 'sun'
  | 'moon'
  | 'search'
  | 'folder'
  | 'folder-open'
  | 'home'
  | 'drive'
  | 'file'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'book'
  | 'wrench'
  | 'package'
  | 'plug'
  | 'link'
  | 'eye'
  | 'download'
  | 'copy'
  | 'pencil'
  | 'trash'
  | 'check'
  | 'x'
  | 'alert'
  | 'sparkle'
  | 'inbox'
  | 'rewind'
  | 'undo'
  | 'columns'
  | 'message'
  | 'thinking'
  | 'shield-alert'
  // 「+ 添加菜单」用到的语义图标（目标 / 计划 / 绘图 / 智能体 / 占位）。
  | 'goal'
  | 'bulb'
  | 'ruler'
  | 'robot'
  | 'ellipsis';

/** 一个图标的几何：路径集合 + 需要的线条/圆点。 */
interface IconShape {
  /** 需要 `path` 的线条（`d` 数组）。 */
  readonly paths?: readonly string[];
  /** 需要 `line` 的线段（`x1 y1 x2 y2`）。 */
  readonly lines?: readonly (readonly [number, number, number, number])[];
  /** 需要 `circle` 的圆（`cx cy r`）。 */
  readonly circles?: readonly (readonly [number, number, number])[];
  /** 需要填充（而非描边）的路径。 */
  readonly filled?: readonly string[];
}

/**
 * 图标几何表（几何取自公开的线性图标语言惯例：24px 网格、2px 线、圆端圆角）。
 *
 * 维护口径：只放**几何**，视框/线宽/颜色由 `icon()` 统一注入 ⇒ 不存在"某个图标线宽 1.5、另一个 2"的漂移。
 */
const SHAPES: Readonly<Record<IconName, IconShape>> = {
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  mic: {
    paths: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2'],
    lines: [[12, 19, 12, 22]],
  },
  paperclip: {
    paths: [
      'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
    ],
  },
  brain: {
    paths: [
      'M12 5a3 3 0 0 0-6 0 3 3 0 0 0-2.1 5.2A3 3 0 0 0 4 16a3 3 0 0 0 4 2.8A3 3 0 0 0 12 19z',
      'M12 5a3 3 0 0 1 6 0 3 3 0 0 1 2.1 5.2A3 3 0 0 1 20 16a3 3 0 0 1-4 2.8A3 3 0 0 1 12 19z',
    ],
  },
  flame: {
    paths: ['M12 2s4 4.5 4 8a4 4 0 0 1-8 0c0-1 .4-2 1-3-.6 3 1 4 1 4s-1-5 2-9z', 'M12 22a5 5 0 0 0 5-5c0-2-1-3.5-2-5 0 2-1.5 3-3 3s-2-1-2-2c-1 1.5-3 3-3 4a5 5 0 0 0 5 5z'],
  },
  sliders: {
    lines: [
      [4, 8, 20, 8],
      [4, 16, 20, 16],
    ],
    circles: [
      [9, 8, 2],
      [15, 16, 2],
    ],
  },
  chart: { paths: ['M4 20V4', 'M4 20h16', 'M8 20v-6', 'M13 20V9', 'M18 20v-9'] },
  shield: { paths: ['M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z'] },
  menu: {
    lines: [
      [4, 7, 20, 7],
      [4, 12, 20, 12],
      [4, 17, 20, 17],
    ],
  },
  gear: {
    paths: [
      'M12 3.5l1.2 2.2 2.5-.4.6 2.5 2.3 1-1.2 2.2 1.2 2.2-2.3 1-.6 2.5-2.5-.4L12 20.5l-1.2-2.2-2.5.4-.6-2.5-2.3-1L6.6 13 5.4 10.8l2.3-1 .6-2.5 2.5.4z',
    ],
    circles: [[12, 12, 2.6]],
  },
  command: { paths: ['M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z'] },
  sun: {
    circles: [[12, 12, 4]],
    paths: ['M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  },
  moon: { paths: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'] },
  search: { paths: ['M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z', 'M21 21l-4.3-4.3'] },
  folder: { paths: ['M3 8a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'] },
  'folder-open': { paths: ['M4 19V6a2 2 0 0 1 2-2h3.2l1.8 2H17a2 2 0 0 1 2 2v1', 'M3 19l2.4-7h15L18 19z'] },
  home: { paths: ['M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z'] },
  drive: {
    paths: ['M4 14h16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M6.5 14L9 5h6l2.5 9'],
    lines: [
      [16.5, 17, 17.5, 17],
      [13.5, 17, 14.5, 17],
    ],
  },
  file: { paths: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'] },
  image: {
    paths: ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M4 16l4.5-4.5 4 4 3-3L20 17'],
    circles: [[9, 10, 1.4]],
  },
  video: { paths: ['M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M16 11l5-3v8l-5-3z'] },
  audio: { paths: ['M10 20V6l9-2v14'], circles: [[6.5, 20, 3], [15.5, 18, 3]] },
  archive: { paths: ['M3 6h18v4H3z', 'M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9', 'M10 14h4'] },
  book: { paths: ['M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z', 'M8 3v18'] },
  wrench: { paths: ['M14.5 3.5a5 5 0 0 0 6.4 6.6L11 20a3 3 0 0 1-4.2-4.2z', 'M9 7.5l2 2'] },
  package: { paths: ['M12 3l8 4v10l-8 4-8-4V7z', 'M4 7l8 4 8-4', 'M12 11v10'] },
  plug: { paths: ['M9 3v6', 'M15 3v6', 'M7 9h10v3a5 5 0 0 1-10 0z', 'M12 17v4'] },
  link: { paths: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.9 6.4', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.2-1.2'] },
  eye: { paths: ['M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z'], circles: [[12, 12, 2.8]] },
  download: { paths: ['M12 4v10', 'M8 11l4 4 4-4', 'M5 19h14'] },
  copy: { paths: ['M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M15 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1'] },
  pencil: { paths: ['M4 20h4l10-10-4-4L4 16z', 'M14.5 5.5l4 4'] },
  trash: { paths: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13'] },
  check: { paths: ['M4.5 12.5l5 5 10-11'] },
  x: { paths: ['M6 6l12 12', 'M18 6L6 18'] },
  alert: { paths: ['M12 4l9 16H3z', 'M12 10v4'], circles: [[12, 17.2, 0.6]] },
  sparkle: { paths: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'] },
  inbox: { paths: ['M4 13V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6', 'M4 13h4l1.5 3h5L16 13h4v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'] },
  rewind: { paths: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'] },
  undo: { paths: ['M4 9h9a5 5 0 0 1 0 10H8', 'M8 5L4 9l4 4'] },
  columns: { paths: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M10 4v16', 'M15 4v16'] },
  message: { paths: ['M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4V7a2 2 0 0 1 2-2z'] },
  thinking: { paths: ['M9.5 4.5a4 4 0 0 0-3.8 5.2A3.5 3.5 0 0 0 6 16.5c.6 2 2.4 3 4.4 3 2.3 0 4.1-1.5 4.4-3.6h.3a3.3 3.3 0 0 0 .4-6.6 4 4 0 0 0-3.5-4.8z', 'M10 22h4'] },
  'shield-alert': { paths: ['M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z', 'M12 8.5v4'], circles: [[12, 16, 0.7]] },
  goal: { paths: ['M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3'], circles: [[12, 12, 5], [12, 12, 1.2]] },
  bulb: { paths: ['M9.5 18h5', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9V18h7v-4.1A6 6 0 0 0 12 3z'] },
  ruler: { paths: ['M3 17L17 3l4 4L7 21z', 'M7 13l2 2', 'M10 10l2 2', 'M13 7l2 2'] },
  robot: {
    paths: ['M5 9h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z', 'M12 5v4'],
    circles: [[9, 13.5, 1], [15, 13.5, 1]],
  },
  ellipsis: { circles: [[6, 12, 1], [12, 12, 1], [18, 12, 1]] },
};

/**
 * 渲染一枚线性图标。
 *
 * @param name 图标名（见 `IconName`）
 * @param props `size` 边长（px，默认 16）、`strokeWidth` 线宽（视框单位，默认 1.8）、
 *              `className` 追加类名、`title` 悬浮提示（**不**参与可读名字，纯鼠标提示）
 * @returns SVG 元素（恒 `aria-hidden`，装饰性）
 */
export function icon(
  name: IconName,
  props: { size?: number; strokeWidth?: number; className?: string; title?: string } = {},
): ReactElement {
  const shape = SHAPES[name];
  const size = props.size ?? 16;
  const sw = props.strokeWidth ?? 1.8;
  const children: ReactElement[] = [];
  for (const d of shape.paths ?? []) children.push(React.createElement('path', { key: `p${children.length}`, d }));
  for (const d of shape.filled ?? [])
    children.push(React.createElement('path', { key: `f${children.length}`, d, fill: 'currentColor', stroke: 'none' }));
  for (const [x1, y1, x2, y2] of shape.lines ?? [])
    children.push(React.createElement('line', { key: `l${children.length}`, x1, y1, x2, y2 }));
  for (const [cx, cy, r] of shape.circles ?? [])
    children.push(React.createElement('circle', { key: `c${children.length}`, cx, cy, r }));

  return React.createElement(
    'svg',
    {
      className: props.className,
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: sw,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      // 装饰性图标：固定对辅助技术隐藏，可读名字由外层按钮的 aria-label 提供。
      'aria-hidden': 'true',
      focusable: 'false',
    },
    props.title ? React.createElement('title', null, props.title) : null,
    ...children,
  );
}
