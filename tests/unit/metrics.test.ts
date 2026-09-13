import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../../src/server/metrics.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 构造事件。 */
function event(type: SessionEvent['type'], sessionId = 's1'): SessionEvent {
  return { id: 'e', type, sessionId, timestamp: '2026-01-01T00:00:00.000Z', payload: {} };
}

test('指标：事件按类型计数与会话去重', () => {
  const metrics = new Metrics();
  metrics.recordEvent(event('user'));
  metrics.recordEvent(event('tool_call'));
  metrics.recordEvent(event('tool_result'));
  metrics.recordEvent(event('user', 's2'));

  const snapshot = metrics.snapshot();
  assert.strictEqual(snapshot.eventsByType['user'], 2);
  assert.strictEqual(snapshot.eventsByType['tool_call'], 1);
  assert.strictEqual(snapshot.eventsByType['tool_result'], 1);
  assert.strictEqual(snapshot.sessions, 2);
});

test('指标：空指标快照保留 eventsByType/sessions 向后兼容字段', () => {
  const snapshot = new Metrics().snapshot();
  assert.deepStrictEqual(snapshot.eventsByType, {});
  assert.strictEqual(snapshot.sessions, 0);
});

test('recordEvent 仍工作（向后兼容）', () => {
  const m = new Metrics();
  m.recordEvent(event('user'));
  m.recordEvent(event('user', 's2'));
  assert.strictEqual(m.snapshot().eventsByType['user'], 2);
  assert.strictEqual(m.snapshot().sessions, 2);
});

test('toPrometheus 含回合/工具/token/cost/事件/会话指标且值正确', () => {
  const m = new Metrics();
  m.recordTurn(1000);
  m.recordTurn(2000);
  m.recordToolCall('read', 500);
  m.recordToolCall('read', 500);
  m.recordTokens('gpt', 10, 20);
  m.recordCost('gpt', 0.01, 0.02);
  m.recordEvent(event('user'));

  const out = m.toPrometheus();
  assert.match(out, /# TYPE omni_turn_duration_seconds/);
  assert.match(out, /omni_turn_duration_seconds 3/);
  assert.match(out, /# TYPE omni_tool_calls_total/);
  assert.match(out, /omni_tool_calls_total\{tool="read"\} 2/);
  assert.match(out, /omni_tool_duration_seconds\{tool="read"\} 1/);
  assert.match(out, /omni_tokens_total\{model="gpt",kind="prompt"\} 10/);
  assert.match(out, /omni_tokens_total\{model="gpt",kind="completion"\} 20/);
  assert.match(out, /omni_cost_total\{model="gpt"\} 0\.03/);
  assert.match(out, /omni_events_total\{type="user"\} 1/);
  assert.match(out, /# TYPE omni_sessions/);
  assert.match(out, /omni_sessions 1/);
});

test('recordTokens/recordCost 按模型聚合', () => {
  const m = new Metrics();
  m.recordTokens('a', 1, 2);
  m.recordTokens('a', 3, 4);
  m.recordCost('a', 0.1, 0.2);
  const out = m.toPrometheus();
  assert.match(out, /omni_tokens_total\{model="a",kind="prompt"\} 4/);
  assert.match(out, /omni_tokens_total\{model="a",kind="completion"\} 6/);
  assert.match(out, /omni_cost_total\{model="a"\} 0\.3/);
});
