import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { sanitizeToolRounds } from '../../src/util/toolRoundSanitizer.js';
import type { ModelMessage } from '../../src/ports/model.js';

const toolCall = (id: string) => ({ id, name: 'x', arguments: {} as Record<string, unknown> });

describe('toolRoundSanitizer（#OBS-8 全链路兜底）', () => {
  it('1. 完整 tool 回合：assistant 紧邻所有响应 → 保留整段', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A'), toolCall('B')] },
      { role: 'tool', content: 'rA', toolCallId: 'A' },
      { role: 'tool', content: 'rB', toolCallId: 'B' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.equal(out.length, 5);
    assert.equal(out[2]?.role, 'tool');
    assert.equal(out[3]?.role, 'tool');
  });

  it('2. 部分响应：tool_calls 之一缺响应 → 整段丢弃（不再让 400 透出）', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A'), toolCall('B')] },
      { role: 'tool', content: 'rA', toolCallId: 'A' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.role, 'user');
    assert.equal(out[1]?.role, 'assistant');
    assert.equal(out[1]?.content, 'done');
  });

  it('3. orphan tool：无前置调用的 tool 消息 → 直接丢弃', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan', toolCallId: 'X' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.role, 'user');
    assert.equal(out[1]?.role, 'assistant');
  });

  it('4. tail 起点是缺响应的 assistant（compact 把响应切到 head）→ 整段丢弃', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A')] },
    ];
    const out = sanitizeToolRounds(messages);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.role, 'user');
  });

  it('5. tool 响应中间被 user 隔断 → 视为无响应（OpenAI 严格按紧邻校验）', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A'), toolCall('B')] },
      { role: 'tool', content: 'rA', toolCallId: 'A' },
      { role: 'user', content: '插入' },
      { role: 'tool', content: 'rB', toolCallId: 'B' },
    ];
    const out = sanitizeToolRounds(messages);
    // assistant 整段被丢（缺 B 的紧邻响应）；中间 user 也算合法消息保留
    assert.equal(out.length, 2);
    assert.equal(out[0]?.role, 'user');
    assert.equal(out[1]?.role, 'user');
    assert.equal(out[1]?.content, '插入');
  });

  it('6. toolCallId 不匹配前置 assistant.tool_calls → 视为该 toolCall 无效（整段丢）', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A')] },
      { role: 'tool', content: 'rB', toolCallId: 'B' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.role, 'user');
  });

  it('7. 无 tool 相关消息 → 原样透传', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.equal(out.length, 3);
  });
});
