// @vitest-environment jsdom

// 中栏头会话时长（2026-10-24 用户截图要求）：把「已完成/进行中 + 用时」渲染在标题旁，
// 且空串/缺省时不留下空占位。纯换算判据在 sessionDuration.test.ts；这里只钉渲染契约。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderFacade } from './rtlHarness.ts';
import { allText, byClass } from './domFacade.ts';

const { ChatHeader } = await import('../src/ui/components/ChatHeader.tsx');

const BASE_PROPS = {
  title: 'demo',
  busy: false,
  view: 'chat' as const,
  onView: () => {},
};

test('已完成态渲染时长胶囊', () => {
  const { node } = renderFacade(ChatHeader, {
    props: { ...BASE_PROPS, duration: '已完成，用时 4秒', durationState: 'done' },
  });
  assert.match(allText(node), /已完成，用时 4秒/u);
  const pills = byClass(node, 'chat-duration');
  assert.strictEqual(pills.length, 1);
  assert.strictEqual(pills[0]?.props['role'], 'status');
  assert.ok(!String(pills[0]?.props['className']).includes('chat-duration-running'));
});

test('进行中态带高亮类', () => {
  const { node } = renderFacade(ChatHeader, {
    props: { ...BASE_PROPS, busy: true, duration: '进行中，用时 1分5秒', durationState: 'running' },
  });
  const pills = byClass(node, 'chat-duration');
  assert.strictEqual(pills.length, 1);
  assert.ok(String(pills[0]?.props['className']).includes('chat-duration-running'));
});

test('空串/缺省不渲染空胶囊', () => {
  const empty = renderFacade(ChatHeader, { props: { ...BASE_PROPS, duration: '' } });
  assert.strictEqual(byClass(empty.node, 'chat-duration').length, 0);
  const absent = renderFacade(ChatHeader, { props: BASE_PROPS });
  assert.strictEqual(byClass(absent.node, 'chat-duration').length, 0);
});
