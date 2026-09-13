import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import { CodexHooksMapper } from '../../src/hooksCompat/codexHooksMapper.js';
import { ClaudeCodeHooksMapper } from '../../src/hooksCompat/claudeCodeHooksMapper.js';
import { HooksCompatAdapter } from '../../src/hooksCompat/hooksCompatAdapter.js';

/** 构造测试事件。 */
function ev(type: SessionEvent['type'], payload: unknown): SessionEvent {
  return {
    id: `id-${type}`,
    type,
    sessionId: 'sess-1',
    timestamp: '2026-08-29T00:00:00.000Z',
    payload,
  };
}

test('codex 映射：六种内部事件 → 对应外部类型', () => {
  const m = new CodexHooksMapper();
  const cases: Array<[SessionEvent['type'], string]> = [
    ['user', 'UserPromptSubmit'],
    ['assistant', 'AgentMessage'],
    ['reasoning', 'AgentReasoning'],
    ['tool_call', 'ToolUse'],
    ['tool_result', 'ToolResult'],
    ['system', 'SystemMessage'],
  ];
  for (const [type, ext] of cases) {
    const out = m.map(ev(type, { k: 'v' }), 1);
    assert.strictEqual(out.type, ext);
    assert.strictEqual(out.sourceType, type);
    assert.strictEqual(out.sequence, 1);
    assert.strictEqual(out.sessionId, 'sess-1');
    assert.deepStrictEqual(out.data, { k: 'v' });
  }
});

test('codex 映射：非对象载荷归一化为 value 字段', () => {
  const m = new CodexHooksMapper();
  const out = m.map(ev('assistant', 'plain string'), 2);
  assert.deepStrictEqual(out.data, { value: 'plain string' });
});

test('claude-code 映射：tool 事件补 tool_use_id 关联', () => {
  const m = new ClaudeCodeHooksMapper();
  const call = m.map(ev('tool_call', { callId: 'call-9', name: 'shell', args: { c: 'ls' } }), 3);
  assert.strictEqual(call.type, 'PreToolUse');
  assert.strictEqual(call.data['tool_use_id'], 'call-9');
  const result = m.map(ev('tool_result', { callId: 'call-9', ok: true }), 4);
  assert.strictEqual(result.type, 'PostToolUse');
  assert.strictEqual(result.data['ok'], true);
});

test('claude-code 映射：用户/系统 → UserPromptSubmit / Notification', () => {
  const m = new ClaudeCodeHooksMapper();
  assert.strictEqual(m.map(ev('user', { content: 'hi' }), 5).type, 'UserPromptSubmit');
  assert.strictEqual(m.map(ev('system', { content: 'x' }), 6).type, 'Notification');
});

test('HooksCompatAdapter：每条内部事件产出两条外部信封（codex + claude）', () => {
  const received: unknown[] = [];
  const adapter = new HooksCompatAdapter((e) => received.push(e));
  adapter.emit(ev('tool_call', { callId: 'c1' }));
  adapter.emit(ev('tool_result', { callId: 'c1', ok: true }));
  assert.strictEqual(received.length, 4);
  // 顺序：codex[0], claude[1], codex[2], claude[3]
  assert.strictEqual((received[0] as { type: string }).type, 'ToolUse');
  assert.strictEqual((received[1] as { type: string }).type, 'PreToolUse');
  assert.strictEqual((received[2] as { type: string }).type, 'ToolResult');
  assert.strictEqual((received[3] as { type: string }).type, 'PostToolUse');
  // sequence 递增且共享
  assert.strictEqual((received[0] as { sequence: number }).sequence, 1);
  assert.strictEqual((received[1] as { sequence: number }).sequence, 1);
  assert.strictEqual((received[2] as { sequence: number }).sequence, 2);
  assert.strictEqual((received[3] as { sequence: number }).sequence, 2);
});

test('HooksCompatAdapter：name 标识正确', () => {
  const adapter = new HooksCompatAdapter(() => undefined);
  assert.strictEqual(adapter.name, 'hooks-compat');
});
