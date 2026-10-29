// 判据：悬浮提示的落位数学（纯函数，无 DOM）。
//
// 用户报障的形态是「太长太宽」：原生 title 气泡把一句话拉成一条横线，且不受 CSS 约束。
// 换成自绘气泡之后，"宽"由 max-width 管住，"位置"就必须自己算——而位置最容易在
// 边角出问题（左栏会话行贴着窗口左缘、输入区 chip 贴着底边）。这里把三类边界钉死：
// 上方优先 / 放不下翻下方 / 水平与垂直都夹进视口。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  HoverTipPlacement,
  TIP_GAP,
  TIP_MARGIN,
} from '../src/ui/models/HoverTipPlacement.ts';

/** 造一个锚点矩形。 */
function anchor(left: number, top: number, width: number, height: number) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const VIEWPORT = { width: 1624, height: 1044 };

test('① 上方放得下：气泡底边离锚点 TIP_GAP，水平居中', () => {
  const pos = HoverTipPlacement.place(
    anchor(700, 400, 120, 24),
    { width: 240, height: 40 },
    VIEWPORT,
  );
  assert.strictEqual(pos.side, 'above');
  assert.strictEqual(pos.left, 640, '水平居中：(700 + 120/2) - 240/2');
  assert.strictEqual(pos.top, 400 - TIP_GAP - 40, '上方：锚点顶 - 间距 - 气泡高');
});

test('② 上方放不下：翻到下方，并贴锚点底边 + TIP_GAP', () => {
  const pos = HoverTipPlacement.place(
    anchor(700, 10, 120, 24),
    { width: 240, height: 40 },
    VIEWPORT,
  );
  assert.strictEqual(pos.side, 'below');
  assert.strictEqual(pos.top, 10 + 24 + TIP_GAP);
});

test('③ 贴左缘（左栏会话行）：水平夹进 TIP_MARGIN，不许跑到屏幕外', () => {
  const pos = HoverTipPlacement.place(
    anchor(TIP_MARGIN, 300, 180, 32),
    { width: 280, height: 40 },
    VIEWPORT,
  );
  assert.strictEqual(pos.left, TIP_MARGIN, `居中会算成负值，必须夹到 ${TIP_MARGIN}px`);
});

test('④ 贴右缘：right 不得越过「视口 - TIP_MARGIN」', () => {
  const pos = HoverTipPlacement.place(
    anchor(VIEWPORT.width - 60, 300, 50, 30),
    { width: 280, height: 40 },
    VIEWPORT,
  );
  assert.strictEqual(pos.left + 280, VIEWPORT.width - TIP_MARGIN);
});

test('⑤ 视口比气泡还矮：上下都放不下时仍夹在视口内（可读优先）', () => {
  const wide = { width: 320, height: 300 };
  const pos = HoverTipPlacement.place(anchor(100, 10, 80, 20), { width: 280, height: 290 }, wide);
  assert.strictEqual(pos.side, 'above');
  assert.ok(pos.top >= TIP_MARGIN, `top 必须 ≥ ${TIP_MARGIN}，实测 ${pos.top}`);
  assert.ok(pos.top + 290 <= wide.height, `气泡底边必须留在视口内，实测 ${pos.top + 290}`);
});

test('⑥ 结果取整：亚像素定位会让 1px 圆角与文字发虚', () => {
  const pos = HoverTipPlacement.place(
    anchor(100.4, 300.6, 120.2, 24.2),
    { width: 241.3, height: 40.5 },
    VIEWPORT,
  );
  assert.strictEqual(pos.left, Math.round(pos.left));
  assert.strictEqual(pos.top, Math.round(pos.top));
});
