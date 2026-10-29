// 判据：悬浮提示接管原生气泡（真实 DOM 行为 + 真实 React 挂载）。
//
// 为什么必须自绘而不是给 `title` 加 CSS：原生 `title` 气泡是浏览器/系统的 UI，
// CSS 完全够不着。所以展示层只能在**悬停期间把 title 摘走**，画自己的节点——这条
// 判据钉的就是"摘得干净、还得回去、别漏出第二套气泡"。
//
// 覆盖真机最容易踩的四个坑：
//   ① 延迟期间 title 不能提前消失（否则鼠标刚停一下提示就没了）；
//   ② 同一条提示内部移动（图标 → 文字）不能收起再弹（闪烁）；
//   ③ React 把 title 写回来时必须再摘一次（否则原生 + 自绘同屏）；
//   ④ 点击 / 滚动 / Esc / 卸载都必须收起且归还 title。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import * as React from 'react';
import { act, fireEvent, render } from './rtlHarness.ts';
import { HoverTips } from '../src/ui/models/HoverTips.ts';
import { TooltipLayer } from '../src/ui/components/TooltipLayer.tsx';

/** 当前用例的卸载器。 */
let detach: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  detach?.();
  detach = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/**
 * 造一个带 title 的按钮并挂进 body。
 * @param title 提示文字
 * @param html 内部 HTML（用于"图标 → 文字"这类子节点移动）
 * @returns 按钮
 */
function buttonWith(title: string, html = '按钮'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.title = title;
  btn.innerHTML = html;
  document.body.append(btn);
  return btn;
}

/**
 * 挂一个控制器并记录回调。
 * @param opts 额外覆盖（如 isBlocked）
 * @returns 记录器与卸载
 */
function mountController(opts: { isBlocked?: () => boolean } = {}) {
  const shown: string[] = [];
  let hidden = 0;
  detach = new HoverTips(document, {
    onShow: (tip) => shown.push(tip.text),
    onHide: () => {
      hidden += 1;
    },
    ...opts,
  }).attach();
  return {
    shown,
    hiddenCount: () => hidden,
  };
}

test('① 延迟到点才摘 title 并显示；离开后原样归还', () => {
  const btn = buttonWith('一段很长的说明：用来验证气泡只显示一眼');
  const rec = mountController();
  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  assert.strictEqual(btn.getAttribute('title'), '一段很长的说明：用来验证气泡只显示一眼', '延迟期间不得提前摘 title');
  vi.advanceTimersByTime(179);
  assert.deepStrictEqual(rec.shown, [], '未到延迟不得显示');
  vi.advanceTimersByTime(1);
  assert.deepStrictEqual(rec.shown, ['一段很长的说明：用来验证气泡只显示一眼']);
  assert.strictEqual(btn.hasAttribute('title'), false, '显示期间原生 title 必须摘掉（否则两套气泡同屏）');
  assert.strictEqual(btn.getAttribute('data-tip'), '一段很长的说明：用来验证气泡只显示一眼', '摘下来的值要能还原');
  btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  assert.strictEqual(btn.getAttribute('title'), '一段很长的说明：用来验证气泡只显示一眼', '离开必须归还 title');
  assert.strictEqual(btn.hasAttribute('data-tip'), false);
  assert.strictEqual(rec.hiddenCount(), 1);
});

test('② 同一条提示内部移动（图标 → 文字）不收起、不重弹', () => {
  const btn = buttonWith('同一条提示', '<span class="ico">i</span><span class="txt">文字</span>');
  const rec = mountController();
  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  const icon = btn.querySelector('.ico');
  const text = btn.querySelector('.txt');
  icon?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  text?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  assert.strictEqual(rec.shown.length, 1, '内部移动不得重弹');
  assert.strictEqual(rec.hiddenCount(), 0, '内部移动不得收起');
});

test('③ 显示期间 React 把 title 写回来：再摘一次并同步文案（不能出现第二套气泡）', async () => {
  const btn = buttonWith('旧文案');
  const rec = mountController();
  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  btn.setAttribute('title', '新文案（重渲染写回）');
  // MutationObserver 在微任务里回调；连冲两次让它把新值挪进 data-tip 并通知刷新。
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(btn.hasAttribute('title'), false, '写回来的 title 必须再被摘掉');
  assert.deepStrictEqual(rec.shown, ['旧文案', '新文案（重渲染写回）'], '气泡文字必须跟着走');
});

test('④ 点击 / 滚动 / Esc / 卸载都收起并归还 title', () => {
  const btn = buttonWith('收起的四个出口');
  const rec = mountController();
  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  assert.strictEqual(btn.getAttribute('title'), '收起的四个出口');
  assert.strictEqual(rec.hiddenCount(), 1);

  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  document.dispatchEvent(new Event('scroll'));
  assert.strictEqual(btn.getAttribute('title'), '收起的四个出口');
  assert.strictEqual(rec.hiddenCount(), 2);

  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  assert.strictEqual(rec.hiddenCount(), 3);

  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  detach?.();
  detach = null;
  assert.strictEqual(btn.getAttribute('title'), '收起的四个出口', '卸载不得把 title 留在 data-tip 里');
  assert.strictEqual(rec.hiddenCount(), 4);
});

test('⑤ 弹层打开时不冒泡（isBlocked）：title 保持原样，不产生第二条浮层', () => {
  const btn = buttonWith('菜单开着的时候不该冒出来');
  const rec = mountController({ isBlocked: () => true });
  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(180);
  assert.deepStrictEqual(rec.shown, []);
  assert.strictEqual(btn.getAttribute('title'), '菜单开着的时候不该冒出来');
});

test('⑥ TooltipLayer：真实 React 下悬停挂载气泡、离开卸载并归还 title', () => {
  const ui = render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(TooltipLayer),
      React.createElement('button', { title: '一段很长的说明文字' }, '按钮'),
    ),
  );
  const btn = ui.container.querySelector('button');
  assert.ok(btn !== null);
  fireEvent.mouseOver(btn);
  act(() => {
    vi.advanceTimersByTime(180);
  });
  const tip = document.querySelector('.hover-tip');
  assert.ok(tip !== null, '悬停后必须出现自绘气泡');
  assert.strictEqual(tip.textContent, '一段很长的说明文字');
  assert.strictEqual(tip.getAttribute('aria-hidden'), 'true', '文字与 title 同源，读屏不该听第二遍');
  assert.strictEqual(btn.hasAttribute('title'), false);
  fireEvent.mouseOut(btn, { relatedTarget: document.body });
  assert.strictEqual(document.querySelector('.hover-tip'), null, '离开后气泡必须卸载');
  assert.strictEqual(btn.getAttribute('title'), '一段很长的说明文字');
});
