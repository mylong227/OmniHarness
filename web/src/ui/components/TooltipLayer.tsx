// 全站悬浮提示的展示层：把 {@link HoverTips} 摘下来的 `title` 画成一张**扁平纸片**。
//
// 为什么要替换原生气泡（2026-10-28 用户：「太长太宽」「扁平设计带圆角」）：
//   原生 `title` 的宽度由浏览器自己决定，一句权限说明会拉成一条横贯屏幕的方角灰板；
//   它既不能圆角、不能限宽，也不跟主题走。这里统一成：
//     · 宽度上限 280px（中文约 22 字/行）——再长的文案按行收，不再变成一条横线；
//     · 扁平：跟随主题的浅底/墨底 + 10px 圆角 + 不投影（投影是菜单/模态的语言）；
//       浅色下是纯白纸片，深色下是 `--panel-2` 墨片（2026-10-28 第三轮用户：「暗色主题
//       冒泡也需要暗色」），两套都靠 1px 发丝边立住；
//     · 最多 4 行后收口——提示是"看一眼"的，不是第二份正文。
//
// 位置由 {@link HoverTipPlacement} 计算：上方优先、下方回退、水平夹进视口。
// 气泡带 `aria-hidden`：文字与元素的 `title` 同源，读屏不该听第二遍。

import * as React from 'react';
import { HoverTips } from '../models/HoverTips.ts';
import type { HoverTipRequest } from '../models/HoverTips.ts';
import { HoverTipPlacement } from '../models/HoverTipPlacement.ts';
import type { TipPosition } from '../models/HoverTipPlacement.ts';
import { currentPopoverId } from '../models/PopoverStack.ts';

/**
 * 悬浮提示层（挂在应用根部一次）。
 * @returns 当前提示节点；没有提示时为 null
 */
export function TooltipLayer(): ReactElement | null {
  const [tip, setTip] = React.useState<HoverTipRequest | null>(null);
  const [pos, setPos] = React.useState<TipPosition | null>(null);
  const bubbleRef = React.useRef<HTMLDivElement | null>(null);
  // 控制器只造一次（lazy state）：回调都是稳定 setState，且必须跨重渲染保持"当前悬停元素"。
  // 不用 useRef 手工懒初始化：StrictMode 下渲染会跑两遍，state 初始化器的语义更明确。
  const [tips] = React.useState<HoverTips>(
    () =>
      new HoverTips(document, {
        onShow: (next) => setTip(next),
        onHide: () => setTip(null),
        // 菜单/选择器打开时不再冒泡：那一屏已经有更重要的浮层了。
        isBlocked: () => currentPopoverId() !== null,
      }),
  );

  React.useEffect(() => tips.attach(), [tips]);

  // 先渲染再测量（气泡宽度由 max-width 与文案共同决定），然后把落位夹进视口。
  // 用 layout effect：测量与定位发生在**绘制前**，不会出现"先闪在左上角再跳过去"。
  React.useLayoutEffect(() => {
    if (tip === null) {
      setPos(null);
      return;
    }
    const bubble = bubbleRef.current;
    if (bubble === null) return;
    const next = HoverTipPlacement.place(
      tip.el.getBoundingClientRect(),
      { width: bubble.offsetWidth, height: bubble.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((prev) =>
      prev !== null && prev.left === next.left && prev.top === next.top ? prev : next,
    );
  }, [tip]);

  if (tip === null) return null;
  return (
    <div
      className="hover-tip"
      aria-hidden="true"
      ref={bubbleRef}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos === null ? 'hidden' : 'visible',
      }}
    >
      {tip.text}
    </div>
  );
}
