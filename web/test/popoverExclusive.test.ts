// 判据：弹层互斥（同屏只能有一个弹层打开）。
//
// 覆盖的缺陷（2026-10-17 用户实测）：输入区三个弹层（`+` 添加菜单 / 请求批准 / 模型与强度）
// 各自用 `useState(open)` 管自己，**互不知情**。用户先点「+」再点「请求批准」，
// 结果两个都留在屏幕上、后者压住前者 ⇒ "背景色把文字掩盖了看不清"。
// 根因是"点外部关闭"走的是 `window.click`，而触发器自己 `stopPropagation()`：
// 打开第二个**不等于**关闭第一个。
//
// 2026-10-28：上下文容量从输入区弹层移入控制台页面，互斥表里不再有它。
//
// 这里直接测 `PopoverStack`（零 React，可单测）；组件侧只需保证"打开前 claim、
// 关闭/卸载 release"（已在三个组件里接入，见各自注释）。
//
// 直跑 web/dist（npm run web:build），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import { test } from 'vitest';

const { claimPopover, releasePopover, closeCurrentPopover, currentPopoverId } = await import(
  '../src/ui/models/PopoverStack.ts'
);

/** 造一个可观察的句柄。 */
function handle(id: string) {
  const state = { closed: 0 };
  return {
    id,
    close: () => {
      state.closed += 1;
    },
    state,
  };
}

test('claim 新的会关掉旧的（这正是缺失的那条互斥）', () => {
  const a = handle('addmenu');
  const b = handle('permission');
  claimPopover(a);
  assert.strictEqual(currentPopoverId(), 'addmenu');
  claimPopover(b);
  assert.strictEqual(a.state.closed, 1, '打开第二个必须先关掉第一个');
  assert.strictEqual(currentPopoverId(), 'permission');
  closeCurrentPopover();
});

test('同一 id 重复 claim 不会自我关闭（组件 effect 与 toggle 都会 claim 一次）', () => {
  const a = handle('model');
  claimPopover(a);
  claimPopover(a); // 同一弹层的第二次声明
  assert.strictEqual(a.state.closed, 0, '同 id 不得把自己关掉');
  assert.strictEqual(currentPopoverId(), 'model');
  closeCurrentPopover();
});

test('release 只对仍持有者生效（防"被顶掉者的清理误清新打开者"）', () => {
  const a = handle('addmenu');
  const b = handle('permission');
  claimPopover(a);
  claimPopover(b); // a 被顶掉，a 的 effect 清理随后会 release('addmenu')
  releasePopover('addmenu');
  assert.strictEqual(currentPopoverId(), 'permission', 'a 的清理不得抹掉 b 的登记');
  closeCurrentPopover();
});

test('closeCurrentPopover 返回是否真的关了（Esc 等全局出口据此判断要不要吞掉按键）', () => {
  assert.strictEqual(closeCurrentPopover(), false, '没有打开者时返回 false');
  const a = handle('model');
  claimPopover(a);
  assert.strictEqual(closeCurrentPopover(), true);
  assert.strictEqual(a.state.closed, 1);
  assert.strictEqual(currentPopoverId(), null);
});

test('关闭后再 claim 另一个：互斥状态不残留', () => {
  const a = handle('addmenu');
  claimPopover(a);
  releasePopover(a.id);
  assert.strictEqual(currentPopoverId(), null);
  const b = handle('model');
  claimPopover(b);
  assert.strictEqual(a.state.closed, 0, 'a 已自行关闭，不该被再关一次');
  assert.strictEqual(currentPopoverId(), 'model');
  closeCurrentPopover();
});

test('三个弹层轮流打开：任意时刻只有一个存活', () => {
  const opened: string[] = [];
  const handles = ['addmenu', 'permission', 'model'].map((id) => {
    const h = handle(id);
    h.close = (() => {
      const orig = h.close;
      return () => {
        opened.pop();
        orig();
      };
    })();
    return h;
  });
  for (const h of handles) {
    claimPopover(h);
    opened.push(h.id);
    assert.strictEqual(opened.length, 1, `打开 ${h.id} 后存活数必须为 1`);
    assert.strictEqual(currentPopoverId(), h.id);
  }
  assert.strictEqual(handles[0].state.closed, 1);
  assert.strictEqual(handles[1].state.closed, 1);
  assert.strictEqual(handles[2].state.closed, 0, '最后一个仍是打开状态');
  closeCurrentPopover();
});
