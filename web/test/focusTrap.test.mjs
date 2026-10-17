// 判据：模态焦点陷阱的绕圈逻辑（纯函数，零 DOM）。
//
// 为什么只测 `nextTabIndex`：DOM 那半段（`focusableWithin` / `trapTab`）依赖
// `document`、`getClientRects`，本仓的 node 环境没有真 DOM。把"绕圈计算"抽成纯函数
// 之后，最容易写错的那部分（首尾回绕、反向、焦点在框外）可以在零 DOM 下严格断言，
// 剩下的 DOM 接线由真机判据（`a11yKeyboard` / e2e）覆盖。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { nextTabIndex } from '../src/ui/models/focusTrap.ts';

test('nextTabIndex：正向从当前走到下一个', () => {
  assert.equal(nextTabIndex(3, 0, false), 1);
  assert.equal(nextTabIndex(3, 1, false), 2);
});

test('nextTabIndex：正向在末位绕回首位（这是"陷阱"的核心）', () => {
  assert.equal(nextTabIndex(3, 2, false), 0);
});

test('nextTabIndex：反向从当前走到上一个', () => {
  assert.equal(nextTabIndex(3, 2, true), 1);
  assert.equal(nextTabIndex(3, 1, true), 0);
});

test('nextTabIndex：反向在首位绕回末位', () => {
  assert.equal(nextTabIndex(3, 0, true), 2);
});

test('nextTabIndex：焦点不在框内时，正向进首位、反向进末位', () => {
  // current = -1 表示"焦点在模态之外"。正向应进入第一个，反向应进入最后一个——
  // 这条是"焦点跑到背后页面上之后，按 Tab 能把它拉回模态"的依据。
  assert.equal(nextTabIndex(3, -1, false), 0);
  assert.equal(nextTabIndex(3, -1, true), 2);
});

test('nextTabIndex：单元素时始终停在它自己（绕圈退化）', () => {
  assert.equal(nextTabIndex(1, 0, false), 0);
  assert.equal(nextTabIndex(1, 0, true), 0);
});

test('nextTabIndex：无可聚焦元素时返回 -1（调用方据此兜底聚焦容器）', () => {
  assert.equal(nextTabIndex(0, -1, false), -1);
  assert.equal(nextTabIndex(0, 0, true), -1);
  assert.equal(nextTabIndex(-1, 0, false), -1);
});

test('nextTabIndex：任意 size 下结果都必须落在 [0, size) 内（不越界）', () => {
  for (let size = 1; size <= 8; size += 1) {
    for (let current = -1; current < size; current += 1) {
      for (const backward of [false, true]) {
        const next = nextTabIndex(size, current, backward);
        assert.ok(
          Number.isInteger(next) && next >= 0 && next < size,
          `size=${size} current=${current} backward=${String(backward)} 得到越界下标 ${String(next)}`,
        );
      }
    }
  }
});

test('nextTabIndex：连续正向走 size 步会回到起点（闭合环）', () => {
  const size = 5;
  let at = 0;
  for (let i = 0; i < size; i += 1) at = nextTabIndex(size, at, false);
  assert.equal(at, 0, '走满一圈应回到起点，否则不是闭合的焦点环');
});
