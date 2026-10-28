import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextShapers } from '../../src/context/contextShapers.ts';
import type { ModelMessage } from '../../src/ports/model/model.ts';

test('CTX-01：超长工具结果做头尾裁剪，user/system 不动', () => {
  const long = 'x'.repeat(30_000);
  const messages: ModelMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '任务' },
    { role: 'tool', content: long, toolCallId: 'c1' },
  ];
  const out = ContextShapers.apply(messages, { maxToolChars: 1000 });
  assert.strictEqual(out.report.trimmedToolResults, 1);
  assert.ok(out.messages[2]!.content.length < long.length);
  assert.ok(out.messages[2]!.content.includes('中段已裁剪'));
  assert.strictEqual(out.messages[0]!.content, 'sys');
  assert.strictEqual(out.messages[1]!.content, '任务');
});

test('CTX-01：超过预算比例时剪旧工具结果，并消毒 orphan tool', () => {
  const big = 'y'.repeat(80_000);
  const messages: ModelMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: {} }] },
    { role: 'tool', content: big, toolCallId: 'a' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'read_file', arguments: {} }] },
    { role: 'tool', content: big, toolCallId: 'b' },
    { role: 'user', content: '继续' },
  ];
  const out = ContextShapers.apply(messages, {
    maxToolChars: 100_000,
    contextWindowTokens: 10,
    keepRecentToolResults: 1,
    aggressive: true,
  });
  assert.ok(out.report.snippedToolResults >= 1);
  // 被剪掉的 assistant.tool_calls 不能留下缺响应的声明（否则上游 400）；
  // 保留的最近一轮可以有 toolCalls。
  const assistantCalls = out.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.toolCalls ?? []);
  assert.ok(!assistantCalls.some((call) => call.id === 'a'), '被剪掉的 a 不应留下声明');
  assert.ok(out.messages.some((message) => message.content === '继续'));
});

test('CTX-01：默认模式裁剪**所有**超长工具结果，重复应用结果稳定（防每步回滚）', () => {
  const long = 'z'.repeat(30_000);
  const messages: ModelMessage[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
    { role: 'tool', content: long, toolCallId: 'c1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: {} }] },
    { role: 'tool', content: long, toolCallId: 'c2' },
  ];
  const first = ContextShapers.apply(messages, { maxToolChars: 1000 });
  const second = ContextShapers.apply(messages, { maxToolChars: 1000 });
  assert.strictEqual(
    first.report.trimmedToolResults,
    2,
    '旧工具结果同样必须被裁（否则下一步恢复全文）',
  );
  assert.deepStrictEqual(first.messages, second.messages, '同一输入重复应用必须逐字节稳定');
  assert.ok(first.messages[1]!.content.length < long.length);
});

test('CTX-01：小消息不做任何改动', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
  ];
  const out = ContextShapers.apply(messages);
  assert.deepStrictEqual(out.messages, messages);
  assert.strictEqual(out.report.trimmedToolResults, 0);
  assert.strictEqual(out.report.snippedToolResults, 0);
});

test('CTX-01：单条 user/assistant 超大消息也要裁（否则 1MB 输入恒超窗）', () => {
  const huge = 'u'.repeat(200_000);
  const messages: ModelMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: huge },
    { role: 'assistant', content: huge },
  ];
  const out = ContextShapers.apply(messages, { maxMessageChars: 1000 });
  assert.strictEqual(out.report.trimmedMessages, 2);
  assert.strictEqual(out.messages[0]!.content, 'sys', 'system 常驻指令不动');
  for (const index of [1, 2]) {
    const content = out.messages[index]!.content;
    assert.ok(content.length < 2000, `裁剪后应远小于原文（实际 ${content.length}）`);
    assert.match(content, /单条消息过长/u);
    assert.ok(content.startsWith('u'), '头部内容保留');
    assert.ok(content.endsWith('u'), '尾部内容保留');
  }
});

test('CTX-01：超大消息裁剪跨次调用稳定（不破坏前缀缓存）', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'v'.repeat(100_000) }];
  const first = ContextShapers.apply(messages, { maxMessageChars: 500 });
  const second = ContextShapers.apply(messages, { maxMessageChars: 500 });
  assert.deepStrictEqual(first.messages, second.messages);
});
