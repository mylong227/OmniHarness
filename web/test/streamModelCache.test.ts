// 事件流模型缓存（审计 §2.5：滚动帧全量重算）——零 DOM，直接驱动缓存与纯函数。
//
// 直跑方式（先 npm run web:build）：node web/test/streamModelCache.test.mjs

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ThreadEvent } from '../src/types/models.ts';

// deps.js 在模块顶层读 window；先种桩再动态 import 编译产物。

const { StreamModelCache } = await import('../src/ui/models/StreamModelCache.ts');

/** 判据的事件线格式：沿用服务端原始形状（timestamp 为字符串、带 sessionId）。 */
interface WireEvent {
  id: string;
  type: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** WireEvent[] → readonly ThreadEvent[]：两类型因 timestamp 口径差异互不可赋值，
 *  被测的缓存 / 纯函数不读该字段，传参处按边界断言收口（运行时零差异）。 */
function asEvents(events: WireEvent[]): readonly ThreadEvent[] {
  return events as unknown as readonly ThreadEvent[];
}

/** 造 n 条「单块」事件（system / assistant 交替，1 条 = 1 个可视块）。 */
function makeEvents(n: number): WireEvent[] {
  const out: WireEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 5 === 0
        ? {
            id: 'a' + i,
            type: 'assistant',
            sessionId: 's1',
            timestamp: '',
            payload: { content: '回复 ' + i },
          }
        : {
            id: 's' + i,
            type: 'system',
            sessionId: 's1',
            timestamp: '',
            payload: { content: '事件 ' + i },
          },
    );
  }
  return out;
}

test('StreamModelCache：同一输入重复取用必须复用同一对象（滚动帧不再重算）', () => {
  const cache = new StreamModelCache();
  const events = makeEvents(300);

  const first = cache.get(asEvents(events), false);
  const second = cache.get(asEvents(events), false);
  const third = cache.get(asEvents(events), false);

  assert.strictEqual(second, first, '同引用同长度同 busy ⇒ 必须返回同一对象');
  assert.strictEqual(third, first);
  const stats = cache.stats();
  assert.strictEqual(stats.computes, 1, '只允许真正计算一次（这正是滚动帧省下的那部分）');
  assert.strictEqual(stats.hits, 2);
});

test('StreamModelCache：events 引用变化必须重算（本仓 reducer 不可变，新事件＝新数组）', () => {
  const cache = new StreamModelCache();
  const before = makeEvents(10);
  const after = [...before, { id: 'new', type: 'user', sessionId: 's1', timestamp: '', payload: {} }];

  const m1 = cache.get(asEvents(before), false);
  const m2 = cache.get(asEvents(after), false);
  assert.notStrictEqual(m2, m1, '新数组必须重算');
  assert.strictEqual(cache.stats().computes, 2);
  assert.strictEqual(m2.blocks.length, m1.blocks.length + 1, '重算结果必须包含新增事件');
});

test('StreamModelCache：就地 push 同一数组（长度变化）也必须重算', () => {
  const cache = new StreamModelCache();
  const events = makeEvents(5);
  const first = cache.get(asEvents(events), false);
  // 就地追加：引用不变、长度变了 —— 缓存必须以长度兜住这类写法
  events.push({ id: 'pushed', type: 'user', sessionId: 's1', timestamp: '', payload: {} });

  const second = cache.get(asEvents(events), false);
  assert.notStrictEqual(second, first, '长度变化必须失效（否则界面会漏掉新事件）');
  assert.strictEqual(second.blocks.length, first.blocks.length + 1);
});

test('StreamModelCache：busy 变化必须重算（过程簇折叠口径随之变化）', () => {
  const cache = new StreamModelCache();
  const events = makeEvents(6);
  const idle = cache.get(asEvents(events), false);
  const busy = cache.get(asEvents(events), true);
  assert.notStrictEqual(busy, idle, 'busy 是失效判据的一部分');
  assert.strictEqual(cache.stats().computes, 2);
});

test('StreamModelCache：缓存产物与纯计算逐字段一致（缓存不改变口径）', () => {
  const cache = new StreamModelCache();
  const events = makeEvents(120);
  const cached = cache.get(asEvents(events), false);
  const fresh = StreamModelCache.build(asEvents(events), false);

  assert.deepStrictEqual(cached.keys, fresh.keys);
  assert.strictEqual(cached.lastUserId, fresh.lastUserId);
  assert.strictEqual(cached.lastAssistantId, fresh.lastAssistantId);
  assert.deepStrictEqual([...cached.toolCallIds], [...fresh.toolCallIds]);
  assert.strictEqual(cached.blocks.length, fresh.blocks.length);
});

test('StreamModelCache：末条用户/助手 id 与工具调用 id 集合口径正确', () => {
  const cache = new StreamModelCache();
  const events = [
    { id: 'u1', type: 'user', sessionId: 's1', timestamp: '', payload: { content: 'a' } },
    { id: 't1', type: 'tool_call', sessionId: 's1', timestamp: '', payload: { callId: 'c1' } },
    { id: 'r1', type: 'tool_result', sessionId: 's1', timestamp: '', payload: { callId: 'c1' } },
    { id: 'a1', type: 'assistant', sessionId: 's1', timestamp: '', payload: { content: 'b' } },
    { id: 'u2', type: 'user', sessionId: 's1', timestamp: '', payload: { content: 'c' } },
    { id: 't2', type: 'tool_call', sessionId: 's1', timestamp: '', payload: {} },
  ];
  const model = cache.get(asEvents(events), false);
  assert.strictEqual(model.lastUserId, 'u2');
  assert.strictEqual(model.lastAssistantId, 'a1');
  assert.deepStrictEqual([...model.toolCallIds].sort(), ['c1', 't2'], '缺 callId 时回落事件 id');
});

test('StreamModelCache：clear 后重新计数（会话切换不继承旧计数）', () => {
  const cache = new StreamModelCache();
  const events = makeEvents(3);
  cache.get(asEvents(events), false);
  cache.get(asEvents(events), false);
  cache.clear();
  assert.deepStrictEqual(cache.stats(), { computes: 0, hits: 0 });
  const again = cache.get(asEvents(events), false);
  assert.strictEqual(cache.stats().computes, 1);
  assert.strictEqual(again.blocks.length, 3);
});

test('StreamModelCache：每段对话独立用时进入渲染模型（未收口段不入表）', () => {
  const events = asEvents([
    { id: 'u1', type: 'user', sessionId: 's1', timestamp: '2026-10-24T00:00:00.000Z', payload: {} },
    { id: 'a1', type: 'assistant', sessionId: 's1', timestamp: '2026-10-24T00:00:03.000Z', payload: {} },
    { id: 'u2', type: 'user', sessionId: 's1', timestamp: '2026-10-24T00:01:00.000Z', payload: {} },
    { id: 'a2', type: 'assistant', sessionId: 's1', timestamp: '2026-10-24T00:01:05.000Z', payload: {} },
  ]);
  const done = StreamModelCache.build(events, false);
  assert.strictEqual(done.turnDurations.get('u1'), 3_000);
  assert.strictEqual(done.turnDurations.get('u2'), 5_000);

  const running = StreamModelCache.build(events, true);
  assert.strictEqual(running.turnDurations.get('u1'), 3_000);
  assert.strictEqual(running.turnDurations.has('u2'), false);
});
