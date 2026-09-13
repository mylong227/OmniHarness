import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import { ModelCallError } from '../../src/ports/model/model.js';
import type { ModelRequest } from '../../src/ports/model/model.js';

/** 临时替换 fetch。 */
async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** 把文本包装为流。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const request: ModelRequest = {
  messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '查一下天气' },
  ],
  tools: [
    { name: 'shell', description: '执行命令', parameters: { type: 'object', properties: {} } },
  ],
};

test('LlamaCpp：非流式生成解析文本/工具调用/用量', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://localhost:11434', model: 'llama3' });
  let captured: { url: string; init: RequestInit } | undefined;
  const body = {
    message: {
      content: '我来查',
      tool_calls: [{ function: { name: 'shell', arguments: { command: 'curl wttr.in' } } }],
    },
    prompt_eval_count: 10,
    eval_count: 5,
  };
  const output = await withFetch(
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.generate(request),
  );

  assert.strictEqual(captured?.url, 'http://localhost:11434/api/chat');
  const sent = JSON.parse(String(captured?.init.body)) as Record<string, unknown>;
  assert.strictEqual(sent['model'], 'llama3');
  assert.strictEqual(sent['stream'], false);
  assert.strictEqual(
    (sent['tools'] as { function: { name: string } }[])[0]?.function?.name,
    'shell',
  );
  assert.strictEqual(output.text, '我来查');
  assert.strictEqual(output.toolCalls?.[0]?.name, 'shell');
  assert.strictEqual(
    (output.toolCalls?.[0]?.arguments as { command: string })['command'],
    'curl wttr.in',
  );
  assert.deepStrictEqual(output.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test('LlamaCpp：流式 NDJSON 累积文本并识别 done 收尾', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://localhost:11434', model: 'llama3' });
  // Ollama 以换行分隔 JSON 对象推送，末条 done:true 收尾。
  const ndjson = [
    '{"message":{"content":"今"},"done":false}\n',
    '{"message":{"content":"天晴"},"done":false}\n',
    '{"done":true,"prompt_eval_count":3,"eval_count":2}\n',
  ].join('');
  const chunks: string[] = [];
  const output = await withFetch(
    async () => new Response(streamOf(ndjson), { status: 200 }),
    () => model.stream(request, { onText: (text) => chunks.push(text) }),
  );
  assert.deepStrictEqual(chunks, ['今', '天晴']);
  assert.strictEqual(output.text, '今天晴');
  assert.strictEqual(output.usage?.totalTokens, 5);
});

test('LlamaCpp：流式工具调用在 done 段合入', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://localhost:11434', model: 'llama3' });
  const ndjson = [
    '{"message":{"content":"好的"},"done":false}\n',
    '{"message":{"tool_calls":[{"function":{"name":"shell","arguments":{"command":"ls"}}}]},"done":true}\n',
  ].join('');
  const output = await withFetch(
    async () => new Response(streamOf(ndjson), { status: 200 }),
    () => model.stream(request, { onText: () => {} }),
  );
  assert.strictEqual(output.toolCalls?.[0]?.name, 'shell');
  assert.strictEqual((output.toolCalls?.[0]?.arguments as { command: string })['command'], 'ls');
});

test('LlamaCpp：非 2xx 抛可重试错误（fail-closed）', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://localhost:11434', model: 'llama3' });
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response('boom', { status: 500 }),
        () => model.generate(request),
      ),
    (err: unknown) => {
      const e = err as ModelCallError;
      return e instanceof ModelCallError && e.status === 500 && e.retryable === true;
    },
  );
});
