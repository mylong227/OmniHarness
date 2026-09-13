import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesModel } from '../../src/adapters/model/responsesModel.js';
import type { ModelRequest } from '../../src/ports/model/model.js';

/** 把文本包装为流。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

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

/** 构造适配器。 */
function model(): ResponsesModel {
  return new ResponsesModel({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-5',
  });
}

/** 测试请求（含 system）。 */
const request: ModelRequest = {
  messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ],
  tools: [
    { name: 'shell', description: '执行命令', parameters: { type: 'object', properties: {} } },
  ],
};

test('Responses：请求体用 instructions + 扁平工具 + input 剥离 system', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  await withFetch(
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: 'resp_1', output: [] }), { status: 200 });
    },
    () => model().generate(request),
  );

  assert.strictEqual(captured?.url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>;
  assert.strictEqual(body['instructions'], '你是助手');
  assert.strictEqual(body['model'], 'gpt-5');
  assert.strictEqual(body['store'], true);

  const input = body['input'] as { role: string }[];
  assert.strictEqual(input.length, 1);
  assert.strictEqual(input[0]?.role, 'user');

  const tools = body['tools'] as { type: string; name: string; parameters: unknown }[];
  assert.strictEqual(tools[0]?.type, 'function');
  assert.strictEqual(tools[0]?.name, 'shell');
  assert.strictEqual('function' in (tools[0] ?? {}), false, '工具应为扁平结构，无 function 嵌套');

  const headers = captured?.init.headers as Record<string, string>;
  assert.strictEqual(headers['Authorization'], 'Bearer sk-test');
});

test('Responses：解析文本 / reasoning / function_call', async () => {
  const payload = {
    id: 'resp_2',
    output: [
      { type: 'reasoning', summary: [{ text: '先分析' }] },
      { type: 'message', content: [{ type: 'output_text', text: '结果' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
    ],
  };
  const output = await withFetch(
    async () => new Response(JSON.stringify(payload), { status: 200 }),
    () => model().generate(request),
  );

  assert.strictEqual(output.reasoning, '先分析');
  assert.strictEqual(output.text, '结果');
  assert.deepStrictEqual(output.toolCalls, [
    { id: 'call_1', name: 'shell', arguments: { command: 'ls' } },
  ]);
});

test('Responses：流式增量回调并以 completed 终态为准', async () => {
  const completed = {
    id: 'resp_3',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '流式结果' }] }],
  };
  const sse = [
    'event: response.output_text.delta\ndata: {"delta":"流式"}\n\n',
    'event: response.output_text.delta\ndata: {"delta":"结果"}\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ response: completed })}\n\n`,
  ].join('');

  const chunks: string[] = [];
  const output = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () => model().stream(request, { onText: (text) => chunks.push(text) }),
  );

  assert.deepStrictEqual(chunks, ['流式', '结果']);
  assert.strictEqual(output.text, '流式结果');
});

test('Responses：previous_response_id 自动续接（服务端持有上下文）', async () => {
  const target = model();
  const bodies: Record<string, unknown>[] = [];
  await withFetch(
    async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'resp_next', output: [] }), { status: 200 });
    },
    async () => {
      await target.generate(request);
      await target.generate(request);
    },
  );

  assert.strictEqual(bodies[0]?.['previous_response_id'], undefined, '首次请求无续接');
  assert.strictEqual(target.responseId(), 'resp_next');
  assert.strictEqual(bodies[1]?.['previous_response_id'], 'resp_next', '二次请求应带上续接锚点');
});

test('Responses：reset 后回到初始锚点', async () => {
  const target = new ResponsesModel({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-5',
    previousResponseId: 'resp_start',
  });
  assert.strictEqual(target.responseId(), 'resp_start');
  await withFetch(
    async () => new Response(JSON.stringify({ id: 'resp_later', output: [] }), { status: 200 }),
    () => target.generate(request),
  );
  assert.strictEqual(target.responseId(), 'resp_later');
  target.reset();
  assert.strictEqual(target.responseId(), 'resp_start');
});

test('Responses：HTTP 失败抛错', async () => {
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response('boom', { status: 500 }),
        () => model().generate(request),
      ),
    /HTTP 500/,
  );
});
