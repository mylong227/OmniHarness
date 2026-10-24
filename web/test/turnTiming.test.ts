import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TurnTiming } from '../src/ui/models/TurnTiming.ts';
import type { ThreadEvent } from '../src/types/models.ts';

/** 最小事件构造。 */
function ev(id: string, type: ThreadEvent['type'], timestamp: number | undefined): ThreadEvent {
  return { id, type, timestamp, payload: {} } as ThreadEvent;
}

test('每段对话独立计时：下一段 user 收口上一段', () => {
  const map = TurnTiming.build(
    [
      ev('u1', 'user', 1_000),
      ev('a1', 'assistant', 3_000),
      ev('u2', 'user', 5_000),
      ev('a2', 'assistant', 7_500),
    ],
    false,
  );
  assert.strictEqual(map.get('u1')?.durationMs, 2_000);
  assert.strictEqual(map.get('u1')?.complete, true);
  assert.strictEqual(map.get('u2')?.durationMs, 2_500);
  assert.strictEqual(map.get('u2')?.complete, true);
});

test('进行中的最后一段不收口（避免假读数）', () => {
  const map = TurnTiming.build(
    [ev('u1', 'user', 1_000), ev('a1', 'assistant', 2_000), ev('u2', 'user', 5_000)],
    true,
  );
  assert.strictEqual(map.get('u1')?.complete, true);
  assert.strictEqual(map.get('u2')?.complete, false);
});

test('时间戳缺失/倒退：duration=0，不抛错', () => {
  const noTs = TurnTiming.build([ev('u1', 'user', undefined), ev('a1', 'assistant', undefined)], false);
  assert.strictEqual(noTs.get('u1')?.durationMs, 0);
  const backwards = TurnTiming.build([ev('u1', 'user', 5_000), ev('a1', 'assistant', 4_000)], false);
  assert.strictEqual(backwards.get('u1')?.durationMs, 0);
});

test('非 user 事件不单独建段；一段只有一个结束点', () => {
  const map = TurnTiming.build(
    [ev('a0', 'assistant', 500), ev('u1', 'user', 1_000), ev('t1', 'tool_call', 2_000), ev('t2', 'tool_result', 3_000)],
    false,
  );
  assert.strictEqual(map.size, 1);
  assert.strictEqual(map.get('u1')?.durationMs, 2_000);
});
