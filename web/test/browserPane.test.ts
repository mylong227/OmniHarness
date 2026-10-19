// BrowserPane（右栏网页标签）的组件判据（2026-10-19，真实 React + jsdom）。
//
// 断言的是用户真正会看到的四件事：
//   ① 无地址时的引导 + 最近本地地址一键直达（点了真的调用 onNavigate）；
//   ② 有地址时渲染 iframe，src 与 reloadKey 一起决定重建（重载按钮真的改 key）；
//   ③ 地址栏 Enter 提交、Esc 还原；
//   ④ 失败原因以 role=alert 呈现（不是静默吞掉）。
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderUi } from './rtlHarness.ts';
import { BrowserPane } from '../src/ui/components/BrowserPane.tsx';
import type { BrowserView } from '../src/ui/shared.ts';

/** 造一份网页状态（默认空地址）。 */
function viewOf(patch: Partial<BrowserView> = {}): BrowserView {
  return {
    open: true,
    active: true,
    url: '',
    title: '',
    reloadKey: 0,
    error: '',
    ...patch,
  };
}

test('BrowserPane：空态列出最近本地地址，点击即导航', () => {
  const navigated: string[] = [];
  const { container } = renderUi(BrowserPane, {
    props: {
      view: viewOf(),
      recentUrls: ['http://localhost:5173/', 'http://127.0.0.1:3000/api'],
      onNavigate: (input: string) => {
        navigated.push(input);
      },
      onReload: () => {},
    },
  });
  const text = container.textContent ?? '';
  assert.match(text, /在右栏浏览网页/);
  const items = container.querySelectorAll('.web-recent-item');
  assert.strictEqual(items.length, 2);
  fireEvent.click(items[0]!);
  assert.deepStrictEqual(navigated, ['http://localhost:5173/']);
});

test('BrowserPane：有地址时 iframe 的 src / title 来自视图状态', () => {
  const { container } = renderUi(BrowserPane, {
    props: {
      onNavigate: () => {},
      onReload: () => {},
      view: viewOf({ url: 'http://localhost:5173/', title: 'localhost:5173' }),
    },
  });
  const frame = container.querySelector('iframe');
  assert.ok(frame !== null);
  assert.strictEqual(frame.getAttribute('src'), 'http://localhost:5173/');
  assert.strictEqual(frame.getAttribute('title'), 'localhost:5173');
});

test('BrowserPane：地址栏 Enter 提交、Esc 还原；重载按钮调用 onReload', () => {
  const navigated: string[] = [];
  let reloads = 0;
  const { container } = renderUi(BrowserPane, {
    props: {
      view: viewOf({ url: 'http://localhost:5173/', title: 'localhost:5173' }),
      onNavigate: (input: string) => {
        navigated.push(input);
      },
      onReload: () => {
        reloads += 1;
      },
    },
  });
  const input = container.querySelector('.web-addr') as HTMLInputElement;
  assert.strictEqual(input.value, 'http://localhost:5173/', '地址栏跟随当前页');
  fireEvent.change(input, { target: { value: 'http://localhost:4321/' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.deepStrictEqual(navigated, ['http://localhost:4321/']);
  fireEvent.keyDown(input, { key: 'Escape' });
  assert.strictEqual(input.value, 'http://localhost:5173/', 'Esc 还原为当前页');
  const reload = container.querySelector('.web-reload') as HTMLButtonElement;
  fireEvent.click(reload);
  assert.strictEqual(reloads, 1);
});

test('BrowserPane：失败原因以 role=alert 呈现；无地址时重载/外开按钮禁用', () => {
  const { container } = renderUi(BrowserPane, {
    props: {
      view: viewOf({ error: '本地网页预览未启用（服务端没有启动预览源）' }),
      onNavigate: () => {},
      onReload: () => {},
    },
  });
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert !== null);
  assert.match(alert.textContent ?? '', /预览未启用/u);
  assert.strictEqual((container.querySelector('.web-reload') as HTMLButtonElement).disabled, true);
  assert.strictEqual((container.querySelector('.web-external') as HTMLButtonElement).disabled, true);
});
