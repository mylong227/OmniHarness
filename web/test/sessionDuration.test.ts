import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SessionDuration } from '../src/ui/models/SessionDuration.ts';

test('空闲：显示服务端有效时长，形如「已完成，用时 4秒」', () => {
  const view = SessionDuration.view(4_000, undefined, 10_000, false);
  assert.strictEqual(view.visible, true);
  assert.strictEqual(view.state, 'done');
  assert.strictEqual(view.label, '已完成，用时 4秒');
});

test('进行中：base + 本地回合增量，每秒刷新', () => {
  const view = SessionDuration.view(0, 10_000, 75_000, true);
  assert.strictEqual(view.visible, true);
  assert.strictEqual(view.state, 'running');
  assert.strictEqual(view.elapsedMs, 65_000);
  assert.strictEqual(view.label, '进行中，用时 1分5秒');
});

test('进行中且已有历史时长：base 与增量相加', () => {
  const view = SessionDuration.view(10_000, 20_000, 25_000, true);
  assert.strictEqual(view.elapsedMs, 15_000);
  assert.strictEqual(view.label, '进行中，用时 15秒');
});

test('空闲且无 activeMs：不显示，不编造 0 秒', () => {
  const view = SessionDuration.view(undefined, undefined, 10_000, false);
  assert.strictEqual(view.visible, false);
  assert.strictEqual(view.label, '');
});

test('非法/负数时长按 0；busySince 未记录时只显示 base', () => {
  const bad = SessionDuration.view(Number.NaN, undefined, 10_000, false);
  assert.strictEqual(bad.visible, false);
  const running = SessionDuration.view(-1, undefined, 10_000, true);
  assert.strictEqual(running.elapsedMs, 0);
  assert.strictEqual(running.label, '进行中，用时 0秒');
});

test('超过 1 小时保留时分秒三段', () => {
  const view = SessionDuration.view(3_665_000, undefined, 0, false);
  assert.strictEqual(view.label, '已完成，用时 1小时1分5秒');
});
