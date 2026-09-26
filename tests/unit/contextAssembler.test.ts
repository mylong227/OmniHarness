import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextAssembler } from '../../src/context/contextAssembler.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 构造事件。 */
function event(type: SessionEvent['type'], payload: unknown, id = 'e'): SessionEvent {
  return { id, type, sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', payload };
}

test('上下文投影：用户与助手消息按序映射', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('user', { content: '你好' }),
    event('assistant', { content: '我在' }),
  ]);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0]?.role, 'user');
  assert.strictEqual(messages[0]?.content, '你好');
  assert.strictEqual(messages[1]?.role, 'assistant');
  assert.strictEqual(messages[1]?.content, '我在');
});

test('上下文投影：工具成功结果映射为 tool 消息', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('tool_result', { callId: 'c1', ok: true, output: '输出内容' }),
  ]);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0]?.role, 'tool');
  assert.strictEqual(messages[0]?.content, '输出内容');
});

test('上下文投影：工具失败结果映射为失败说明', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('tool_result', { callId: 'c1', ok: false, error: '出错了' }),
  ]);
  assert.strictEqual(messages[0]?.content, '工具执行失败: 出错了');
});

test('上下文投影：推理与工具调用事件不进入模型消息', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('reasoning', { content: '思考中' }),
    event('tool_call', { callId: 'c1', name: 'shell', args: {} }),
  ]);
  assert.strictEqual(messages.length, 0);
});

test('上下文投影：系统事件映射为 system 消息（技能注入）', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([event('system', { content: '# 技能：code-review' })]);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0]?.role, 'system');
  assert.strictEqual(messages[0]?.content, '# 技能：code-review');
});

test('上下文投影：空事件序列返回空消息', () => {
  const assembler = new ContextAssembler();
  assert.strictEqual(assembler.build([]).length, 0);
});

test('上下文投影：固定碎片注入在消息最前（world_state）', () => {
  const assembler = new ContextAssembler(['# 工作区状态\n当前目录: src/']);
  const messages = assembler.build([event('user', { content: '看下代码' })]);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0]?.role, 'system');
  assert.match(messages[0]?.content ?? '', /工作区状态/);
  assert.strictEqual(messages[1]?.role, 'user');
});

test('U2：build 接受动态系统碎片并注入在固定碎片之后、事件之前', () => {
  const assembler = new ContextAssembler(['STATIC']);
  const messages = assembler.build([event('user', { content: '看下代码' })], ['DYNAMIC']);
  // STATIC 系统消息 + DYNAMIC 系统消息 + user 消息
  assert.strictEqual(messages.length, 3);
  assert.strictEqual(messages[0]?.role, 'system');
  assert.strictEqual(messages[0]?.content, 'STATIC');
  assert.strictEqual(messages[1]?.role, 'system');
  assert.strictEqual(messages[1]?.content, 'DYNAMIC');
  assert.strictEqual(messages[2]?.role, 'user');
});

test('U2：无额外碎片时单参数调用行为不变（向后兼容）', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([event('user', { content: 'hi' })]);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0]?.role, 'user');
});

test('U2：空字符串动态碎片被跳过', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([], ['', 'KEEP', '']);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0]?.content, 'KEEP');
});

test('上下文投影：reasoning 挂到本回合 assistant(tool_calls) 消息（DeepSeek 思考模式回传）', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('reasoning', { content: '我要读文件' }),
    event('tool_call', { callId: 'c1', name: 'read_file', args: { path: 'a.ts' } }),
    event('tool_result', { callId: 'c1', ok: true, output: 'ok' }),
  ]);
  assert.strictEqual(messages.length, 2);
  const assistantMsg = messages.find((m) => m.role === 'assistant');
  assert.strictEqual(assistantMsg?.reasoningContent, '我要读文件');
  assert.strictEqual(assistantMsg?.toolCalls?.length, 1);
});

test('上下文投影：reasoning 挂到纯文本 assistant 消息', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('reasoning', { content: '想一想' }),
    event('assistant', { content: '答案是 42' }),
  ]);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0]?.reasoningContent, '想一想');
  assert.strictEqual(messages[0]?.content, '答案是 42');
});

test('上下文投影：reasoning 不跨回合残留旧文本（但思考模式激活后补全空串占位）', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('reasoning', { content: '第一轮思考' }),
    event('assistant', { content: '第一轮回答' }),
    event('user', { content: '继续' }),
    event('assistant', { content: '第二轮回答' }),
  ]);
  assert.strictEqual(messages.length, 3);
  assert.strictEqual(messages[0]?.role, 'assistant');
  assert.strictEqual(messages[0]?.reasoningContent, '第一轮思考');
  assert.strictEqual(messages[1]?.role, 'user');
  // 思考模式已激活：后续 assistant 必须带 reasoning_content 字段维持一致（空串占位），
  // 既不泄漏旧思考文本，也不缺失字段（后者会触发 DeepSeek 思考模式 HTTP 400）。
  assert.strictEqual(messages[2]?.reasoningContent, '');
});

test('OBS-6：思考模式激活后，缺 reasoning 的 assistant(tool_calls) 也补空串占位', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('reasoning', { content: '第一轮思考' }),
    event('assistant', { content: '第一轮回答' }),
    event('user', { content: '读文件' }),
    // 本回合模型未返回 reasoning（只调工具），但思考模式已激活
    event('tool_call', { callId: 'c1', name: 'read_file', args: { path: 'a.ts' } }),
    event('tool_result', { callId: 'c1', ok: true, output: 'ok' }),
  ]);
  const toolAssistant = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length === 1);
  assert.notStrictEqual(toolAssistant, undefined);
  assert.strictEqual(toolAssistant?.reasoningContent, '');
});

test('OBS-6：思考模式激活后多轮交替（有/无 reasoning）始终一致', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('reasoning', { content: 'R1' }),
    event('assistant', { content: 'A1' }),
    event('user', { content: 'u1' }),
    event('assistant', { content: 'A2' }), // 无 reasoning
    event('user', { content: 'u2' }),
    event('reasoning', { content: 'R3' }),
    event('assistant', { content: 'A3' }),
  ]);
  const assistants = messages.filter((m) => m.role === 'assistant');
  assert.strictEqual(assistants.length, 3);
  assert.strictEqual(assistants[0]?.reasoningContent, 'R1');
  assert.strictEqual(assistants[1]?.reasoningContent, ''); // 空串占位，维持一致
  assert.strictEqual(assistants[2]?.reasoningContent, 'R3');
});

test('OBS-6：纯非思考对话（全程无 reasoning）绝不注入 reasoning_content 字段', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('assistant', { content: 'A1' }),
    event('user', { content: 'u1' }),
    event('assistant', { content: 'A2' }),
    event('tool_call', { callId: 'c1', name: 'f', args: {} }),
    event('tool_result', { callId: 'c1', ok: true, output: 'ok' }),
  ]);
  const assistants = messages.filter((m) => m.role === 'assistant');
  for (const a of assistants) {
    assert.strictEqual(a?.reasoningContent, undefined);
  }
});

test('A7：turn_diff 必须回灌给模型（原先被投影丢弃，模型看不到自己改了什么）', () => {
  const assembler = new ContextAssembler();
  const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
  const messages = assembler.build([event('turn_diff', { content: diff })]);
  assert.strictEqual(messages.length, 1, '应产生一条回灌消息');
  assert.strictEqual(messages[0]?.role, 'user');
  assert.match(messages[0]?.content ?? '', /实际改动 diff/);
  assert.match(messages[0]?.content ?? '', /\+new/, 'diff 正文必须可见');
});

test('A7：超大 diff 回灌时有上限（保留头部 + 截断说明）', () => {
  const assembler = new ContextAssembler();
  const huge = `--- a/x.ts\n+++ b/x.ts\n${'+x'.repeat(ContextAssembler.MAX_DIFF_CHARS)}\n`;
  const messages = assembler.build([event('turn_diff', { content: huge })]);
  const content = messages[0]?.content ?? '';
  assert.ok(content.length < huge.length, '必须被截断');
  assert.match(content, /diff 已截断/);
});

test('A7：空 diff 不产生消息（零噪声）', () => {
  const assembler = new ContextAssembler();
  assert.deepStrictEqual(assembler.build([event('turn_diff', { content: '   ' })]), []);
});
