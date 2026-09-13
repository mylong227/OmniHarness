// T4.5（H5 只读自省 trace）可证伪验收：
//   ① 只读保证：快照深拷贝 + 冻结——消费方改副本不影响源；返回数组本身冻结；
//   ② 可复现消费：同事件流 + 同过滤 ⇒ 两次查询结果逐字段一致（seq 稳定）；
//   ③ byKind 过滤正确且新在前；recent(k) 截断正确；
//   ④ fail-soft：provider 抛错回空快照不抛错。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReadonlyTraceReader } from '../../src/adapters/telemetry/readonlyTraceReader.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

function event(type: string, payload: unknown, at: string): SessionEvent {
  return {
    id: `e-${type}-${at}`,
    type: type as SessionEvent['type'],
    sessionId: 's1',
    timestamp: at,
    payload,
  };
}

const EVENTS: readonly SessionEvent[] = [
  event('user.message', '任务开始', '2026-09-13T01:00:00Z'),
  event('tool.call', { tool: 'shell', callId: 'c1' }, '2026-09-13T01:00:05Z'),
  event(
    'tool.denied',
    { tool: 'shell', callId: 'c1', error: 'policy deny' },
    '2026-09-13T01:00:06Z',
  ),
  event('turn.end', { steps: 2 }, '2026-09-13T01:00:10Z'),
];

test('① 只读保证：改副本不影响源，返回值冻结', () => {
  const source: SessionEvent[] = [...EVENTS];
  const reader = new ReadonlyTraceReader(() => source);
  const snap = reader.recent();
  assert.ok(Object.isFrozen(snap), '返回数组须冻结');
  assert.ok(Object.isFrozen(snap[0]), '条目须冻结');
  // 只读保证：篡改快照字段直接抛错（冻结），事件流本体不可触。
  const before = source[1]!.payload;
  assert.throws(() => {
    (snap[1] as { summary: string }).summary = 'tampered';
  }, /read only|read-only/i);
  assert.strictEqual(source[1]!.payload, before, '事件流本体原样');
});

test('② 可复现消费：同流同过滤两次查询逐字段一致', () => {
  const reader = new ReadonlyTraceReader(() => EVENTS);
  const a = reader.recent(3).map((e) => [e.seq, e.at, e.kind, e.summary]);
  const b = reader.recent(3).map((e) => [e.seq, e.at, e.kind, e.summary]);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a[0]![0] as number, 3, 'seq 取流内稳定序号（新在前，首条为末事件）');
});

test('③ byKind 过滤 + 新在前 + recent(k) 截断', () => {
  const reader = new ReadonlyTraceReader(() => EVENTS);
  const denied = reader.byKind('tool.denied');
  assert.strictEqual(denied.length, 1);
  assert.match(denied[0]!.summary, /policy deny/);
  const recent2 = reader.recent(2);
  assert.strictEqual(recent2.length, 2);
  assert.strictEqual(recent2[0]!.kind, 'turn.end', '新在前');
  assert.strictEqual(recent2[1]!.kind, 'tool.denied');
});

test('④ fail-soft：provider 抛错回空快照，不抛错', () => {
  const reader = new ReadonlyTraceReader(() => {
    throw new Error('storage blip');
  });
  assert.deepStrictEqual(reader.recent(), []);
  assert.deepStrictEqual(reader.byKind('tool.call'), []);
});
