/**
 * `threads.get` 分页切片判据（S2，2026-10-25）。
 *
 * 钉住：默认全量（兼容旧客户端）、尾部优先、`before` 向上补拉、未知 before 不猜。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ThreadPage } from '../../src/server/services/session/threadPage.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

/** 造 n 条事件（id=e0..eN）。 */
function events(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${String(index)}`,
    sessionId: 's',
    type: 'user',
    timestamp: new Date(Date.UTC(2026, 9, 25, 0, 0, index)).toISOString(),
    payload: { content: String(index) },
  }));
}

test('ThreadPage：不给 limit 返回全量且 hasMore=false', () => {
  const page = ThreadPage.slice(events(10));
  assert.strictEqual(page.items.length, 10);
  assert.strictEqual(page.hasMore, false);
  assert.strictEqual(page.oldestId, 'e0');
});

test('ThreadPage：limit 取尾部，hasMore 正确', () => {
  const page = ThreadPage.slice(events(10), 3);
  assert.deepStrictEqual(
    page.items.map((event) => event.id),
    ['e7', 'e8', 'e9'],
  );
  assert.strictEqual(page.hasMore, true);
  assert.strictEqual(page.oldestId, 'e7');
});

test('ThreadPage：before 返回它之前的一页（不含该条）', () => {
  const page = ThreadPage.slice(events(10), 3, 'e7');
  assert.deepStrictEqual(
    page.items.map((event) => event.id),
    ['e4', 'e5', 'e6'],
  );
  assert.strictEqual(page.hasMore, true);
  // 补到最早一页时 hasMore 必须变 false。
  const first = ThreadPage.slice(events(10), 3, 'e4');
  assert.deepStrictEqual(
    first.items.map((event) => event.id),
    ['e1', 'e2', 'e3'],
  );
  assert.strictEqual(first.hasMore, true);
  const head = ThreadPage.slice(events(10), 3, 'e1');
  assert.deepStrictEqual(head.items.map((event) => event.id), ['e0']);
  assert.strictEqual(head.hasMore, false);
});

test('ThreadPage：未知 before 如实报错，不静默返回尾部', () => {
  const page = ThreadPage.slice(events(10), 3, 'nope');
  assert.deepStrictEqual(page.items, []);
  assert.strictEqual(page.error, 'unknown_before');
});

test('ThreadPage：limit 夹取到 1..1000', () => {
  const huge = ThreadPage.slice(events(10), 99999);
  assert.strictEqual(huge.items.length, 10);
  const zero = ThreadPage.slice(events(10), 0);
  assert.strictEqual(zero.items.length, 10, '0 视为不分页');
  const negative = ThreadPage.slice(events(10), -5);
  assert.strictEqual(negative.items.length, 10);
});
