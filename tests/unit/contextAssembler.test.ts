import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextAssembler } from '../../src/context/contextAssembler.ts';
import { EventFactory } from '../../src/core/eventFactory.ts';
import type { FileAttachment } from '../../src/ports/model/fileAttachment.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

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

test('上下文投影：失败结果只有 output 时也必须把原因交给模型（run_code 回归）', () => {
  const assembler = new ContextAssembler();
  const messages = assembler.build([
    event('tool_result', {
      callId: 'c1',
      ok: false,
      output: 'ReferenceError: fs is not defined\n  at <anonymous>:1:1',
    }),
  ]);
  assert.strictEqual(
    messages[0]?.content,
    '工具执行失败: ReferenceError: fs is not defined\n  at <anonymous>:1:1',
    '错误在 output 时不得退化成「未知错误」',
  );
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

test('A7：turn_diff 必须回灌给模型（payload 字段是 diff——2026-10-03 修死投影后夹具改用真实形状）', () => {
  const assembler = new ContextAssembler();
  const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
  const messages = assembler.build([event('turn_diff', { diff })]);
  assert.strictEqual(messages.length, 1, '应产生一条回灌消息');
  assert.strictEqual(messages[0]?.role, 'user');
  assert.match(messages[0]?.content ?? '', /实际改动 diff/);
  assert.match(messages[0]?.content ?? '', /\+new/, 'diff 正文必须可见');
});

test('A7：生产事件工厂形状（EventFactory.turnDiff → { diff }）投影后 diff 可见', () => {
  const assembler = new ContextAssembler();
  const factory = new EventFactory();
  const diff = '--- a/y.ts\n+++ b/y.ts\n@@ -1,1 +1,1 @@\n-old\n+new';
  const messages = assembler.build([factory.turnDiff('sess', diff)]);
  assert.strictEqual(messages.length, 1, '真实工厂事件必须回灌（旧缺陷：恒空串被卫语句吞掉）');
  assert.match(messages[0]?.content ?? '', /\+new/);
});

test('A7：超大 diff 回灌时有上限（保留头部 + 截断说明）', () => {
  const assembler = new ContextAssembler();
  const huge = `--- a/x.ts\n+++ b/x.ts\n${'+x'.repeat(ContextAssembler.MAX_DIFF_CHARS)}\n`;
  const messages = assembler.build([event('turn_diff', { diff: huge })]);
  const content = messages[0]?.content ?? '';
  assert.ok(content.length < huge.length, '必须被截断');
  assert.match(content, /diff 已截断/);
});

test('A7：空 diff 不产生消息（零噪声）', () => {
  const assembler = new ContextAssembler();
  assert.deepStrictEqual(assembler.build([event('turn_diff', { diff: '   ' })]), []);
});

test('P2-⑬：工具附件紧跟其工具轮次 flush（不再落到整段对话末尾）', () => {
  const assembler = new ContextAssembler();
  const att: FileAttachment = { name: 'a.png', mediaType: 'image/png', data: 'x' };
  const messages = assembler.build([
    event('user', { content: '看这张图' }),
    event('tool_call', { callId: 'c1', name: 'view_image', args: { path: 'a.png' } }),
    event('tool_result', { callId: 'c1', ok: true, output: 'ok', files: [att] }),
    // 第 2 步：模型继续对话——附件必须在第 1 轮结束后就 flush，而不是压到最后。
    event('assistant', { content: '这是图里的内容' }),
    event('user', { content: '下一问' }),
    event('assistant', { content: '答' }),
  ]);
  const attachIndex = messages.findIndex(
    (m) => m.role === 'user' && m.content.startsWith('[工具读取的文件附件]'),
  );
  const toolIndex = messages.findIndex((m) => m.role === 'tool');
  const laterAssistant = messages.findIndex((m) => m.role === 'assistant' && m.content === '答');
  assert.ok(attachIndex > toolIndex, '附件在 tool 消息之后（不破坏配对）');
  assert.ok(attachIndex < laterAssistant, '附件必须在其产生轮次附近，而非对话末尾');
});

test('图片附件预算：按模型窗口自适应（小窗口只留最新一张，2026-10-21）', () => {
  // 8000 token 窗口 ⇒ 25% 预算 / 每张 1600 ≈ 1 张；两张小图（字符远低于 700k）仍只留最新。
  const assembler = new ContextAssembler([], undefined, 8_000);
  const events: SessionEvent[] = [
    event('user', { content: 'first' }),
    event('tool_call', { callId: 'c1', name: 'view_image', args: {} }),
    event('tool_result', {
      callId: 'c1',
      ok: true,
      output: 'ok',
      files: [{ name: 'old.png', mediaType: 'image/png', data: 'a' }],
    }),
    event('assistant', { content: 'seen old' }),
    event('user', { content: 'second' }),
    event('tool_call', { callId: 'c2', name: 'view_image', args: {} }),
    event('tool_result', {
      callId: 'c2',
      ok: true,
      output: 'ok',
      files: [{ name: 'new.png', mediaType: 'image/png', data: 'b' }],
    }),
  ];
  const messages = assembler.build(events);
  const withData = messages.filter((m) => (m.files ?? []).some((f) => f.data !== undefined));
  assert.strictEqual(withData.length, 1, '小窗口只应保留最新一张图片');
  assert.strictEqual(withData[0]?.files?.[0]?.name, 'new.png');
  const dropped = messages.filter((m) => m.content.includes('较早的图片附件已省略'));
  assert.strictEqual(dropped.length, 1);
  assert.match(dropped[0]?.content ?? '', /old\.png/);
});

test('图片附件预算：只保留最近的附件，旧附件降级为文字（2026-10-19 鹈鹕会话回归）', () => {
  // 事故：7 张截图（6.2 MiB base64）在 45 次调用里累计重传 82.4 MiB，后期单次生成 247–314 秒。
  // 预算 700k 字符 ⇒ 两张 900k 的截图只保留最新一张，旧的一张降级为带文件名的文字。
  const assembler = new ContextAssembler();
  const big = 'x'.repeat(900_000);
  const events: SessionEvent[] = [];
  for (let i = 0; i < 2; i += 1) {
    events.push(
      event('tool_call', { callId: `c${String(i)}`, name: 'browser_screenshot', args: {} }),
      event('tool_result', {
        callId: `c${String(i)}`,
        ok: true,
        output: 'ok',
        files: [{ name: `s${String(i)}.png`, mediaType: 'image/png', data: big }],
      }),
      event('assistant', { content: `seen ${String(i)}` }),
    );
  }
  const messages = assembler.build(events);
  const withData = messages.filter((m) => (m.files?.length ?? 0) > 0);
  assert.strictEqual(withData.length, 1, '900k + 900k > 1.5M ⇒ 只保留最新一张');
  assert.strictEqual(withData[0]?.files?.[0]?.name, 's1.png');
  const dropped = messages.filter((m) => m.content.includes('较早的图片附件已省略'));
  assert.strictEqual(dropped.length, 1, '旧附件消息必须降级（保留文件名）');
  assert.match(dropped[0]?.content ?? '', /s0\.png/);
  assert.strictEqual(dropped[0]?.files, undefined, '被省略的消息不得再携带 base64');
});
