import { test } from 'vitest';
import assert from 'node:assert/strict';

import { InterruptedToolCalls } from '../../src/core/interruptedToolCalls.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

/** 构造最小事件（只需 type/payload，其余字段对判据无意义）。 */
function event(type: SessionEvent['type'], payload: unknown, id = 'e'): SessionEvent {
  return { id, type, sessionId: 's', timestamp: '2026-10-21T00:00:00.000Z', payload };
}

test('对账：只挑出「有 tool_call、无 tool_result」的悬空调用', () => {
  const events: SessionEvent[] = [
    event('user', { content: 'do it' }, 'e1'),
    event('tool_call', { callId: 'c1', name: 'write_file', args: { path: 'a.ts' } }, 'e2'),
    event('tool_result', { callId: 'c1', ok: true, output: 'ok' }, 'e3'),
    event('tool_call', { callId: 'c2', name: 'shell', args: { command: 'rm x' } }, 'e4'),
    // c2 没有结果：模拟进程在 tool_call 与 tool_result 之间被杀。
    event('tool_call', { callId: 'c3', name: 'read_file', args: {} }, 'e5'),
  ];
  assert.deepStrictEqual(InterruptedToolCalls.pendingOf(events), [
    { callId: 'c2', name: 'shell' },
    { callId: 'c3', name: 'read_file' },
  ]);
});

test('对账：失败结果同样是「已对账」（ok:false 不等于缺失）', () => {
  const events: SessionEvent[] = [
    event('tool_call', { callId: 'c1', name: 'shell' }, 'e1'),
    event('tool_result', { callId: 'c1', ok: false, error: 'boom' }, 'e2'),
  ];
  assert.deepStrictEqual(InterruptedToolCalls.pendingOf(events), []);
});

test('对账：坏事件（缺 callId / 非字符串）被忽略，不误报也不抛错', () => {
  const events: SessionEvent[] = [
    event('tool_call', { name: 'shell' }, 'e1'),
    event('tool_call', { callId: 42, name: 'shell' }, 'e2'),
    event('tool_result', { callId: null }, 'e3'),
    event('user', { content: 'hi' }, 'e4'),
  ];
  assert.deepStrictEqual(InterruptedToolCalls.pendingOf(events), []);
});

test('对账：同一 callId 重复出现只报一次（按出现顺序）', () => {
  const events: SessionEvent[] = [
    event('tool_call', { callId: 'c1', name: 'a' }, 'e1'),
    event('tool_call', { callId: 'c1', name: 'a' }, 'e2'),
  ];
  assert.deepStrictEqual(InterruptedToolCalls.pendingOf(events), [{ callId: 'c1', name: 'a' }]);
});
