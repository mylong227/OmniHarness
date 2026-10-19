// 外链卡片的「预览」入口判据（2026-10-19）。
//
// 只有**回环** http(s) 地址才显示右栏预览按钮：公网页面多数用 X-Frame-Options 拒绝嵌入，
// 给一个点了必然空白的入口比不给更糟。同时钉住「按钮不能嵌进 <a>」（嵌套交互控件会被 axe 判红）。
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderUi } from './rtlHarness.ts';
import { ExternalLinkCards } from '../src/ui/components/stream/ExternalLinkCards.tsx';

test('ExternalLinkCards：回环地址给「预览」按钮，点击回传原 URL', () => {
  const opened: string[] = [];
  const url = 'http://localhost:5173/';
  const { container } = renderUi(ExternalLinkCards, {
    props: { urls: [url], onOpenInPanel: (u: string) => opened.push(u) },
  });
  const button = container.querySelector('.link-card-open') as HTMLButtonElement | null;
  assert.ok(button !== null, '回环地址必须有右栏预览入口');
  assert.strictEqual(button.closest('a'), null, '预览按钮不得嵌在 <a> 里（嵌套交互控件）');
  fireEvent.click(button);
  assert.deepStrictEqual(opened, [url]);
});

test('ExternalLinkCards：公网地址不显示预览入口（iframe 多半被拒绝嵌入）', () => {
  const { container } = renderUi(ExternalLinkCards, {
    props: { urls: ['https://example.com/a'], onOpenInPanel: () => {} },
  });
  assert.strictEqual(container.querySelector('.link-card-open'), null);
});
