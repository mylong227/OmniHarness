// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderFacade } from './rtlHarness.ts';
import { allText, byClass } from './domFacade.ts';

const { UserCard } = await import('../src/ui/components/stream/UserCard.tsx');

const EV = {
  id: 'u1',
  type: 'user',
  timestamp: 1_700_000_000_000,
  payload: { content: 'hello' },
} as never;

test('用户消息头显示本段独立用时', () => {
  const { node } = renderFacade(UserCard, {
    props: { ev: EV, canEdit: false, turnDurationMs: 65_000, onEdit: () => {} },
  });
  assert.match(allText(node), /本轮用时 1分5秒/u);
  assert.strictEqual(byClass(node, 'turn-duration').length, 1);
});

test('不足 1 秒/缺省不显示（避免无信息量的 0秒）', () => {
  const short = renderFacade(UserCard, {
    props: { ev: EV, canEdit: false, turnDurationMs: 500, onEdit: () => {} },
  });
  assert.strictEqual(byClass(short.node, 'turn-duration').length, 0);
  const absent = renderFacade(UserCard, { props: { ev: EV, canEdit: false, onEdit: () => {} } });
  assert.strictEqual(byClass(absent.node, 'turn-duration').length, 0);
});
