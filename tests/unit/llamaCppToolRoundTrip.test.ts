/**
 * 本地模型（Ollama / llama.cpp 原生 `/api/chat`）**请求侧**多轮工具回传单测。
 *
 * 清偿 `docs/PROJECT_BOARD.md` §3.1 登记的遗留项：`buildRequest` 此前把每条消息压成
 * `{role, content}` 两个字段 ⇒ assistant 的 `tool_calls` 与工具结果的 `tool_name` **全部丢失**，
 * 原生多轮工具对话在这一适配器上不成立（模型看不到自己调用过什么，也看不到结果来自哪个工具）。
 *
 * 语义依据是 **Ollama 官方 API 文档**（`docs/api.md` 的 "Generate a chat completion" →
 * message 字段表：`tool_calls`（`[{function:{name,arguments}}]`，arguments 为**对象**、无 `id`）、
 * `tool_name`（工具结果消息用）、`images`（**base64 列表**）），不是抓包实录。
 * 故本文件用 stub fetch **断言我们真正发出去的请求体**：
 *   ① assistant.tool_calls 按文档形态回传（对象参数、不带 id）；
 *   ② 工具结果消息带 `tool_name`（由同请求 assistant 的 id→名映射精确取值，不解析 id 字符串）；
 *   ③ `images` 内联为纯 base64（剥掉 data URL 前缀）；不可内联的 URL 形式不发假字段；
 *   ④ 纯文本历史逐字段零变化（改造前行为不是「顺带被改掉」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import type { ModelMessage, ModelRequest } from '../../src/ports/model/model.js';

/** 捕获一次请求体后返回固定响应。 */
async function captureBody(messages: readonly ModelMessage[]): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    captured = JSON.parse(String((init as { body?: string }).body ?? '{}')) as Record<
      string,
      unknown
    >;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    const model = new LlamaCppModel({ baseUrl: 'http://127.0.0.1:1', model: 'probe' });
    const request: ModelRequest = { messages, tools: [] };
    await model.generate(request);
    return captured;
  } finally {
    globalThis.fetch = original;
  }
}

/** 取 wire 消息数组。 */
function wireMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  return (body['messages'] ?? []) as Record<string, unknown>[];
}

test('① assistant.tool_calls 按文档形态回传：arguments 是对象、条目不带 id', async () => {
  const body = await captureBody([
    { role: 'user', content: '读两个文件' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'read_file', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: 'read_file#2', name: 'read_file', arguments: { path: 'b.ts' } },
      ],
    },
    { role: 'tool', content: 'A', toolCallId: 'read_file' },
    { role: 'tool', content: 'B', toolCallId: 'read_file#2' },
  ]);
  const messages = wireMessages(body);
  const assistant = messages[1] ?? {};
  const calls = (assistant['tool_calls'] ?? []) as Record<string, unknown>[];
  assert.strictEqual(calls.length, 2, '两次调用都要回传（旧实现整段丢失）');
  assert.deepStrictEqual(calls[0], {
    function: { name: 'read_file', arguments: { path: 'a.ts' } },
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(calls[0] ?? {}, 'id'),
    false,
    'Ollama 的 tool_calls 条目没有 id 字段，不得凭空加',
  );
});

test('② 工具结果消息带 tool_name，且由同请求 id→名映射精确取值（不解析 id 字符串）', async () => {
  const body = await captureBody([
    { role: 'user', content: '查天气' },
    {
      role: 'assistant',
      content: '',
      // 构造一个「名字本身含 #」的工具：解析 id 字符串会解成 `weird`，映射则精确。
      toolCalls: [{ id: 'weird#3', name: 'weird#3', arguments: {} }],
    },
    { role: 'tool', content: '晴', toolCallId: 'weird#3' },
  ]);
  const messages = wireMessages(body);
  assert.strictEqual(messages[2]?.['role'], 'tool');
  assert.strictEqual(messages[2]?.['content'], '晴');
  assert.strictEqual(
    messages[2]?.['tool_name'],
    'weird#3',
    '必须取映射里的真实工具名，而不是把 id 按 # 切开',
  );
});

test('②b 找不到对应调用时**不编造** tool_name（缺字段好过假字段）', async () => {
  const body = await captureBody([
    { role: 'user', content: 'x' },
    { role: 'tool', content: '孤儿结果', toolCallId: 'no-such-call' },
  ]);
  const messages = wireMessages(body);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(messages[1] ?? {}, 'tool_name'), false);
});

test('③ images 内联为纯 base64（剥 data URL 前缀）；不可内联的 URL 不发假字段', async () => {
  const body = await captureBody([
    {
      role: 'user',
      content: '看图',
      images: [
        { data: 'QUJD', mediaType: 'image/png' },
        { url: 'data:image/png;base64,REVG', mediaType: 'image/png' },
        { url: 'https://example.test/remote.png', mediaType: 'image/png' },
      ],
    },
  ]);
  const messages = wireMessages(body);
  assert.deepStrictEqual(
    messages[0]?.['images'],
    ['QUJD', 'REVG'],
    '只发能内联的 base64；http(s) URL 无法不下载即内联，不得编字段',
  );
});

test('④ 纯文本历史逐字段零变化（role + content，无多余键）', async () => {
  const body = await captureBody([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你' },
  ]);
  assert.deepStrictEqual(wireMessages(body), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你' },
  ]);
});
