import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppendOnlyEventLog } from '../../src/core/eventLog.js';
import { EventFactory } from '../../src/core/eventFactory.js';

test('事件日志：追加后大小与顺序正确', () => {
  const log = new AppendOnlyEventLog();
  log.appendUser('s1', '第一句');
  log.appendAssistant('s1', '第二句');
  assert.strictEqual(log.size(), 2);
  const events = log.all();
  assert.strictEqual(events[0]?.type, 'user');
  assert.strictEqual(events[1]?.type, 'assistant');
});

test('事件日志：按类型过滤', () => {
  const log = new AppendOnlyEventLog();
  log.appendUser('s1', '你好');
  log.appendToolCall('s1', 'c1', 'shell', { command: 'ls' });
  log.appendToolResult('s1', 'c1', true, 'ok');
  assert.strictEqual(log.byType('user').length, 1);
  assert.strictEqual(log.byType('tool_call').length, 1);
  assert.strictEqual(log.byType('tool_result').length, 1);
});

test('事件日志：最新一条事件', () => {
  const log = new AppendOnlyEventLog();
  log.appendUser('s1', 'a');
  log.appendAssistant('s1', 'b');
  assert.strictEqual(log.latest()?.type, 'assistant');
  assert.strictEqual((log.latest()?.payload as { content: string }).content, 'b');
});

test('事件日志：空日志返回空', () => {
  const log = new AppendOnlyEventLog();
  assert.strictEqual(log.size(), 0);
  assert.strictEqual(log.latest(), undefined);
  assert.strictEqual(log.all().length, 0);
});

test('事件工厂：事件结构完整', () => {
  const event = EventFactory.toolCall('s1', 'c1', 'shell', { command: 'ls' });
  assert.strictEqual(event.type, 'tool_call');
  assert.strictEqual(event.sessionId, 's1');
  assert.ok(event.id.length > 0);
  assert.ok(event.timestamp.length > 0);
  const payload = event.payload as { callId: string; name: string };
  assert.strictEqual(payload.callId, 'c1');
  assert.strictEqual(payload.name, 'shell');
});
