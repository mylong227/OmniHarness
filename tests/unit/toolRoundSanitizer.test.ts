import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { sanitizeToolRounds } from '../../src/util/toolRoundSanitizer.js';
import type { ModelMessage } from '../../src/ports/model/model.js';

const toolCall = (id: string) => ({ id, name: 'x', arguments: {} as Record<string, unknown> });

describe('toolRoundSanitizer（#OBS-8 全链路兜底，最低破坏版）', () => {
  it('1. 完整 tool 回合：所有 toolCall 都有紧邻响应 → 原样保留', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A'), toolCall('B')] },
      { role: 'tool', content: 'rA', toolCallId: 'A' },
      { role: 'tool', content: 'rB', toolCallId: 'B' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.strictEqual(out.length, 5);
    assert.strictEqual(out[2]?.role, 'tool');
    assert.strictEqual(out[3]?.role, 'tool');
  });

  it('2. 部分响应：从 assistant.toolCalls 移除未响应 id，assistant 本体保留', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A'), toolCall('B')] },
      { role: 'tool', content: 'rA', toolCallId: 'A' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeToolRounds(messages);
    // user + assistant(filtered toolCalls=[A]) + tool(rA) + assistant(done) = 4
    assert.strictEqual(out.length, 4);
    assert.strictEqual(out[0]?.role, 'user');
    const a = out[1];
    assert.strictEqual(a?.role, 'assistant');
    assert.strictEqual(a?.toolCalls?.length, 1);
    assert.strictEqual(a?.toolCalls?.[0]?.id, 'A');
    assert.strictEqual(out[2]?.role, 'tool');
    assert.strictEqual(out[3]?.content, 'done');
  });

  it('3. orphan tool：无前置调用的 tool 消息 → 直接丢弃', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan', toolCallId: 'X' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0]?.role, 'user');
    assert.strictEqual(out[1]?.role, 'assistant');
  });

  it('4. assistant 缺响应：assistant 仍保留但 toolCalls 清空（避免 downstream 400）', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'no response', toolCalls: [toolCall('A')] },
    ];
    const out = sanitizeToolRounds(messages);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0]?.role, 'user');
    const a = out[1];
    assert.strictEqual(a?.role, 'assistant');
    assert.strictEqual(a?.toolCalls, undefined);
    assert.strictEqual(a?.content, 'no response');
  });

  it('5. tool 响应中间被 user 隔断 → 该 id 不被认领（合法的 openai 紧邻约束）', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A'), toolCall('B')] },
      { role: 'tool', content: 'rA', toolCallId: 'A' },
      { role: 'user', content: '插入' },
      { role: 'tool', content: 'rB', toolCallId: 'B' },
    ];
    const out = sanitizeToolRounds(messages);
    // A 紧邻响应 OK，validIds={A}；B 隔断后不算合法。
    // 重建：user, assistant(toolCalls=[A]), tool(rA), user(插入), tool(rB) 丢
    assert.strictEqual(out.length, 4);
    assert.strictEqual(out[0]?.role, 'user');
    assert.strictEqual(out[1]?.role, 'assistant');
    assert.strictEqual(out[1]?.toolCalls?.length, 1);
    assert.strictEqual(out[1]?.toolCalls?.[0]?.id, 'A');
    assert.strictEqual(out[2]?.role, 'tool');
    assert.strictEqual(out[3]?.role, 'user');
    assert.strictEqual(out[3]?.content, '插入');
  });

  it('6. toolCallId 不匹配前置 assistant.tool_calls → tool 丢，assistant 去 toolCalls', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [toolCall('A')] },
      { role: 'tool', content: 'rB', toolCallId: 'B' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0]?.role, 'user');
    const a = out[1];
    assert.strictEqual(a?.role, 'assistant');
    assert.strictEqual(a?.toolCalls, undefined);
  });

  it('7. 无 tool 相关消息 → 原样透传', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = sanitizeToolRounds(messages);
    assert.strictEqual(out.length, 3);
  });

  it('8. reasoning_content 与 content 在过滤 toolCalls 后仍保留', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'final answer',
        reasoningContent: 'I think about it...',
        toolCalls: [toolCall('A')],
      },
    ];
    const out = sanitizeToolRounds(messages);
    assert.strictEqual(out.length, 2);
    const a = out[1];
    assert.strictEqual(a?.content, 'final answer');
    assert.strictEqual(a?.reasoningContent, 'I think about it...');
    assert.strictEqual(a?.toolCalls, undefined);
  });
});
