import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import type { ModelRequest, StreamCallbacks, ToolInputDelta } from '../../src/ports/model.js';

/** 把文本包装为可读流（SSE 主体）。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** 临时替换全局 fetch。 */
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

/** 测试请求（含一个工具，便于触发工具调用流）。 */
const request: ModelRequest = {
  messages: [{ role: 'user', content: '列出当前目录' }],
  tools: [
    { name: 'shell', description: '执行命令', parameters: { type: 'object', properties: {} } },
  ],
};

test('#B3 Anthropic 流式：渐进推送工具输入增量（input_json_delta）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    model: 'claude-3',
  });
  const deltas: ToolInputDelta[] = [];
  const sse =
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"shell"}}\n\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\""}}\n\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"}"}}\n\n' +
    'data: {"type":"content_block_stop","index":1}\n\n';
  await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    async () => {
      const cb: StreamCallbacks = { onText: () => {}, onToolInput: (d) => deltas.push(d) };
      await model.stream(request, cb);
    },
  );
  assert.strictEqual(deltas.length, 4, 'start + 3 个增量片段应各触发一次 onToolInput');
  assert.strictEqual(deltas[0]!.name, 'shell');
  assert.strictEqual(deltas[0]!.id, 'toolu_01');
  assert.strictEqual(deltas[0]!.partialJson, '', '开始时应先推一次空增量（UI 立即显示「调用中」）');
  assert.strictEqual(deltas[1]!.partialJson, '{"cmd":');
  assert.strictEqual(deltas[2]!.partialJson, '{"cmd":"ls"');
  assert.strictEqual(deltas[3]!.partialJson, '{"cmd":"ls"}', '最终片段应拼出完整参数 JSON');
});

test('#B3 OpenAI 流式：渐进推送工具调用参数（tool_calls.arguments 片段）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4',
  });
  const deltas: ToolInputDelta[] = [];
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\""}}]}}]}\n\n' +
    'data: [DONE]\n\n';
  await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    async () => {
      const cb: StreamCallbacks = { onText: () => {}, onToolInput: (d) => deltas.push(d) };
      await model.stream(request, cb);
    },
  );
  assert.strictEqual(deltas.length, 3, 'name 片段 + 2 个参数片段');
  assert.strictEqual(deltas[0]!.name, 'shell');
  assert.strictEqual(deltas[0]!.id, 'call_1');
  assert.strictEqual(deltas[0]!.partialJson, '', '首个片段仅含 name，参数尚未开始');
  assert.strictEqual(deltas[1]!.partialJson, '{"cmd":');
  assert.strictEqual(deltas[2]!.partialJson, '{"cmd":"ls"', '增量应逐步累积参数片段');
});

test('#B3 向后兼容：无工具调用时只走 onText，不触发 onToolInput', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    model: 'claude-3',
  });
  let texts = '';
  let toolCalls = 0;
  const sse =
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}\n\n';
  await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    async () => {
      const cb: StreamCallbacks = {
        onText: (t) => {
          texts += t;
        },
        onToolInput: () => {
          toolCalls += 1;
        },
      };
      await model.stream(request, cb);
    },
  );
  assert.strictEqual(texts, '你好世界', '纯文本应照常累积');
  assert.strictEqual(toolCalls, 0, '无工具调用时不应触发 onToolInput');
});
