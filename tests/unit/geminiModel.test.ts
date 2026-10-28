/**
 * Gemini 原生适配器判据（全部用注入 fetch 假响应，不打外网）。
 *
 * 覆盖：非流式文本、工具调用、工具结果回传、usage/缓存、thinkingBudget 映射、
 * API Key 缺失 fail-closed、HTTP 4xx/5xx 分类、超时/调用方取消、流式文本/工具/用量/结束、
 * 非法工具参数 JSON 的 fail-closed 语义，以及流中错误帧。
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { GeminiModel, type GeminiModelConfig } from '../../src/adapters/model/geminiModel.ts';
import { ModelCallError } from '../../src/ports/model/model.ts';
import type { ModelRequest } from '../../src/ports/model/model.ts';
import { ArgParser } from '../../src/cli/argParser.ts';
import { cliHelp } from '../../src/cli/cliHelp.ts';
import { ConfigBuilder } from '../../src/config/configBuilder.ts';
import { ConfigError } from '../../src/config/configError.ts';
import { endpointDefaults } from '../../src/util/endpointDefaults.ts';

/** 默认测试配置（显式给 Key，避免读到本机环境变量）。 */
const BASE_CONFIG: GeminiModelConfig = {
  apiKey: 'gemini-test-key',
  baseUrl: 'https://gemini.test/v1beta',
  model: 'gemini-2.5-flash',
  timeoutMs: 5_000,
};

/** 测试请求：一条 system + 一条 user，带一个工具。 */
const REQUEST: ModelRequest = {
  messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ],
  tools: [
    {
      name: 'shell',
      description: '执行命令',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ],
};

/** 把文本包装为响应体流。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** 临时替换 fetch（测试后恢复，避免跨用例污染）。 */
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

/** 构造 JSON 响应。 */
function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

/** 保存/恢复指定环境变量。 */
async function withEnv(
  patch: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('非流式：URL/鉴权头/systemInstruction/contents 与文本、结束原因解析', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const output = await withFetch(
    async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
          cachedContentTokenCount: 4,
        },
      });
    },
    () => model.generate(REQUEST),
  );
  assert.strictEqual(
    capturedUrl,
    'https://gemini.test/v1beta/models/gemini-2.5-flash:generateContent',
  );
  const headers = capturedInit?.headers as Record<string, string>;
  assert.strictEqual(headers['x-goog-api-key'], 'gemini-test-key');
  assert.strictEqual(headers['content-type'], 'application/json');
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.deepStrictEqual(body['systemInstruction'], { parts: [{ text: '你是助手' }] });
  const contents = body['contents'] as { role: string; parts: unknown[] }[];
  assert.deepStrictEqual(
    contents.map((item) => item.role),
    ['user'],
  );
  assert.deepStrictEqual(contents[0]?.parts, [{ text: '你好' }]);
  const declarations = (body['tools'] as { functionDeclarations: { name: string }[] }[])[0];
  assert.strictEqual(declarations?.functionDeclarations[0]?.name, 'shell');
  assert.strictEqual(output.text, '你好');
  assert.strictEqual(output.finishReason, 'stop');
  assert.strictEqual(output.usage?.cachedPromptTokens, 4);
  assert.strictEqual(output.usage?.totalTokens, 15);
});

test('非流式：functionCall → 工具调用（缺 id 时按名字合成，arguments 解析）', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const output = await withFetch(
    async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: '我来执行' },
                { functionCall: { name: 'shell', args: { command: 'ls' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    () => model.generate(REQUEST),
  );
  assert.strictEqual(output.text, '我来执行');
  assert.deepStrictEqual(output.toolCalls, [
    { id: 'shell', name: 'shell', arguments: { command: 'ls' } },
  ]);
});

test('非流式：assistant 工具调用与 tool 结果回传为 functionCall / functionResponse', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  let capturedBody: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    },
    () =>
      model.generate({
        messages: [
          { role: 'user', content: '读文件' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', content: '文件内容', toolCallId: 'call_1' },
        ],
        tools: [
          {
            name: 'read_file',
            description: '读文件',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
  );
  const contents = capturedBody?.['contents'] as {
    role: string;
    parts: Record<string, unknown>[];
  }[];
  assert.strictEqual(contents[1]?.role, 'model');
  assert.deepStrictEqual(contents[1]?.parts, [
    { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } } },
  ]);
  assert.strictEqual(contents[2]?.role, 'user');
  assert.deepStrictEqual(contents[2]?.parts, [
    {
      functionResponse: {
        id: 'call_1',
        name: 'read_file',
        response: { result: '文件内容' },
      },
    },
  ]);
});

test('usage / 缓存 / 思考 token：completion 由 candidates+thoughts 合成', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const output = await withFetch(
    async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '答' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 7,
          totalTokenCount: 117,
        },
      }),
    () => model.generate(REQUEST),
  );
  assert.deepStrictEqual(output.usage, {
    promptTokens: 100,
    completionTokens: 17,
    totalTokens: 117,
    cachedPromptTokens: 40,
  });
  assert.strictEqual(output.finishReason, 'length', 'MAX_TOKENS 必须归一化为 length');
});

test('thinkingBudget 映射：7 档 → 官方允许区间内的固定预算', async () => {
  const expected: Readonly<Record<string, number>> = {
    none: 0,
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16_384,
    xhigh: 24_576,
    max: 32_768,
  };
  const model = new GeminiModel({ ...BASE_CONFIG, model: 'gemini-2.5-pro' });
  for (const [effort, budget] of Object.entries(expected)) {
    let captured: Record<string, unknown> | undefined;
    await withFetch(
      async (_url, init) => {
        captured = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
      },
      () => model.generate({ ...REQUEST, reasoningEffort: effort }),
    );
    const generation = captured?.['generationConfig'] as
      { thinkingConfig?: { thinkingBudget?: number } } | undefined;
    assert.strictEqual(
      generation?.thinkingConfig?.thinkingBudget,
      budget,
      `reasoningEffort=${effort} 应映射 ${budget}`,
    );
  }
});

test('thinkingBudget：Flash 的 max 档按官方上限 clamp 到 24576（Pro 才是 32768）', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  let captured: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    },
    () => model.generate({ ...REQUEST, reasoningEffort: 'max' }),
  );
  const generation = captured?.['generationConfig'] as
    { thinkingConfig?: { thinkingBudget?: number } } | undefined;
  assert.strictEqual(generation?.thinkingConfig?.thinkingBudget, 24_576);
});

test('thinkingBudget：未登记档位 fail-closed，且不发请求', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  let called = false;
  await assert.rejects(
    () =>
      withFetch(
        async () => {
          called = true;
          return jsonResponse({});
        },
        () => model.generate({ ...REQUEST, reasoningEffort: 'ultra' }),
      ),
    /无法把 reasoningEffort="ultra" 映射成 thinkingBudget/u,
  );
  assert.strictEqual(called, false, '映射失败必须在发请求前抛出');
});

test('配置默认值：maxOutputTokens / reasoningEffort / temperature 进入 generationConfig', async () => {
  const model = new GeminiModel({
    ...BASE_CONFIG,
    maxOutputTokens: 2048,
    reasoningEffort: 'low',
  });
  let captured: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    },
    () => model.generate({ ...REQUEST, temperature: 0 }),
  );
  const generation = captured?.['generationConfig'] as Record<string, unknown> | undefined;
  assert.strictEqual(generation?.['maxOutputTokens'], 2048);
  assert.strictEqual(generation?.['temperature'], 0, '温度 0 必须原样发送');
  assert.deepStrictEqual(generation?.['thinkingConfig'], { thinkingBudget: 2048 });
});

test('API Key 缺失：构造期 fail-closed，消息列出两个环境变量与 --api-key', async () => {
  await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () => {
    assert.throws(
      () => new GeminiModel({ model: 'gemini-2.5-flash' }),
      /GEMINI_API_KEY[\s\S]*GOOGLE_API_KEY[\s\S]*--api-key/u,
    );
  });
});

test('API Key：GOOGLE_API_KEY 可作为 apiKey 缺省来源', async () => {
  await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: 'google-key' }, async () => {
    const model = new GeminiModel({ model: 'gemini-2.5-flash' });
    let capturedHeader: unknown;
    await withFetch(
      async (_url, init) => {
        capturedHeader = (init.headers as Record<string, string>)['x-goog-api-key'];
        return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
      },
      () => model.generate(REQUEST),
    );
    assert.strictEqual(capturedHeader, 'google-key');
  });
});

test('注册接线：--model-adapter gemini 可用，endpoints 兜底与凭据环境变量就绪', () => {
  const args = ArgParser.parseArgs(['--prompt', 'hi', '--model-adapter', 'gemini']);
  assert.strictEqual(args?.modelAdapter, 'gemini');
  const defaults = endpointDefaults.adapterDefaults('gemini');
  assert.strictEqual(defaults?.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.strictEqual(defaults?.model, 'gemini-2.5-flash');
  assert.strictEqual(defaults?.requiresApiKey, true);
  assert.strictEqual(defaults?.apiKeyEnv, 'GEMINI_API_KEY');
  assert.strictEqual(defaults?.modelEnv, 'GEMINI_MODEL');
  // --help 的枚举由 cliEnums.MODEL_ADAPTERS（同一清单）派生，新适配器必须自动出现。
  assert.match(
    cliHelp.render(),
    /--model-adapter mock\|openai\|anthropic\|responses\|llamacpp\|gemini/u,
  );
});

test('配置路由：缺 Key 时 ConfigError fail-closed；有 Key 时构造 GeminiModel', async () => {
  await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () => {
    assert.throws(
      () => ConfigBuilder.buildRouterAdapter({ model: 'gemini-2.5-flash', adapter: 'gemini' }),
      (error: unknown) => error instanceof ConfigError && /GEMINI_API_KEY/u.test(error.message),
    );
  });
  await withEnv({ GEMINI_API_KEY: 'router-key' }, () => {
    const model = ConfigBuilder.buildRouterAdapter({
      model: 'gemini-2.5-flash',
      adapter: 'gemini',
    });
    assert.ok(model instanceof GeminiModel);
    assert.strictEqual(model.name, 'gemini');
  });
});

test('HTTP 4xx/5xx：status/retryable 与 Retry-After 解析', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const bad = await withFetch(
    async () => new Response('bad request', { status: 400 }),
    () =>
      model.generate(REQUEST).then(
        () => undefined,
        (error: unknown) => error,
      ),
  );
  assert.ok(bad instanceof ModelCallError);
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.retryable, false);

  const overloaded = await withFetch(
    async () =>
      new Response('overloaded', {
        status: 503,
        headers: { 'retry-after': '2' },
      }),
    () =>
      model.generate(REQUEST).then(
        () => undefined,
        (error: unknown) => error,
      ),
  );
  assert.ok(overloaded instanceof ModelCallError);
  assert.strictEqual(overloaded.status, 503);
  assert.strictEqual(overloaded.retryable, true);
  assert.strictEqual(overloaded.retryAfterMs, 2000);
});

/** 假 fetch：永不回包，仅在 signal 中止时 reject（模拟服务端接受连接后静默）。 */
function stalledFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === undefined || signal === null) {
      return;
    }
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('超时：空闲超时收敛为可重试 ModelCallError', async () => {
  const model = new GeminiModel({ ...BASE_CONFIG, timeoutMs: 120 });
  const started = Date.now();
  const error = await withFetch(stalledFetch, () =>
    model.generate(REQUEST).then(
      () => undefined,
      (reason: unknown) => reason,
    ),
  );
  const elapsed = Date.now() - started;
  assert.ok(error instanceof ModelCallError, `应抛 ModelCallError，实际 ${String(error)}`);
  assert.strictEqual(error.retryable, true);
  assert.ok(elapsed < 3_000, `必须有界失败（实测 ${String(elapsed)}ms）`);
});

test('取消：调用方 AbortSignal 穿透守卫，且不归类为可重试超时', async () => {
  const model = new GeminiModel({ ...BASE_CONFIG, timeoutMs: 5_000 });
  const controller = new AbortController();
  let started = false;
  const running = withFetch(
    async (_url, init) => {
      started = true;
      return stalledFetch(_url, init);
    },
    () => model.generate({ ...REQUEST, signal: controller.signal }),
  );
  for (let index = 0; index < 200 && !started; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  const error = await running.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error);
  assert.strictEqual(error instanceof ModelCallError, false, '调用方取消不应被伪装成超时错误');
  assert.match(error.message, /aborted/u);
});

test('流式：文本增量 / 工具调用 / usage / 结束原因（SSE）', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"你"}]},"index":0}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"好"}]},"index":0}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"shell","args":{"command":"ls"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
  ].join('');
  const chunks: string[] = [];
  const toolDeltas: string[] = [];
  let capturedUrl = '';
  const output = await withFetch(
    async (url) => {
      capturedUrl = url;
      return new Response(streamOf(sse), { status: 200 });
    },
    () =>
      model.stream(REQUEST, {
        onText: (text) => chunks.push(text),
        onToolInput: (delta) => toolDeltas.push(delta.partialJson),
      }),
  );
  assert.match(capturedUrl, /:streamGenerateContent\?alt=sse$/u);
  assert.deepStrictEqual(chunks, ['你', '好']);
  assert.strictEqual(output.text, '你好');
  assert.deepStrictEqual(output.toolCalls, [
    { id: 'call_1', name: 'shell', arguments: { command: 'ls' } },
  ]);
  assert.deepStrictEqual(output.usage, {
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
  });
  assert.strictEqual(output.finishReason, 'stop');
  assert.deepStrictEqual(toolDeltas, ['{"command":"ls"}']);
});

test('流式：思考文本不进正文，只进 reasoning', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"先想一想","thought":true},{"text":"答案"}]}}]}\n\n',
  ].join('');
  const chunks: string[] = [];
  const output = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () => model.stream(REQUEST, { onText: (text) => chunks.push(text) }),
  );
  assert.deepStrictEqual(chunks, ['答案']);
  assert.strictEqual(output.text, '答案');
  assert.strictEqual(output.reasoning, '先想一想');
});

test('流式：error 帧 → 结构化可重试错误（不把半截输出当成功）', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const sse = 'data: {"error":{"code":429,"message":"quota exceeded"}}\n\n';
  const error = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () =>
      model.stream(REQUEST, { onText: () => undefined }).then(
        () => undefined,
        (reason: unknown) => reason,
      ),
  );
  assert.ok(error instanceof ModelCallError);
  assert.strictEqual(error.status, 429);
  assert.strictEqual(error.retryable, true);
});

test('流式：响应体缺失 fail-closed（不伪造空成功）', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const error = await withFetch(
    async () => new Response(null, { status: 200 }),
    () =>
      model.stream(REQUEST, { onText: () => undefined }).then(
        () => undefined,
        (reason: unknown) => reason,
      ),
  );
  assert.ok(error instanceof ModelCallError);
  assert.match(error.message, /缺少响应体/u);
});

test('非法工具参数 JSON：按 ToolArgumentParser 语义回退空对象且不抛错', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const output = await withFetch(
    async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: 'bad', name: 'shell', args: '{"command":' } },
                { functionCall: { id: 'array', name: 'shell', args: [1, 2] } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    () => model.generate(REQUEST),
  );
  const calls = output.toolCalls ?? [];
  assert.deepStrictEqual(
    calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
    [
      { id: 'bad', name: 'shell', arguments: {} },
      { id: 'array', name: 'shell', arguments: {} },
    ],
  );
  assert.ok(
    calls.every((call) => typeof call.parseError === 'string'),
    '不可修复的参数必须带 parseError，交给执行器 fail-closed',
  );
});

test('图片：裸 base64 走 inlineData；http(s) 不可内联时降级为文本说明', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  let captured: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    },
    () =>
      model.generate({
        messages: [
          {
            role: 'user',
            content: '看图',
            images: [
              { data: 'QUJD', mediaType: 'image/png' },
              { url: 'https://example.test/a.png', mediaType: 'image/png' },
            ],
          },
        ],
        tools: [],
      }),
  );
  const contents = captured?.['contents'] as { parts: Record<string, unknown>[] }[];
  assert.deepStrictEqual(contents[0]?.parts, [
    { text: '看图' },
    { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
    { text: '[图片不可用] 仅支持内联 base64；请重新附加或上传到 Gemini Files API。' },
  ]);
});

test('结构化输出：json-schema → responseMimeType + responseJsonSchema', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  let captured: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    },
    () =>
      model.generate({
        ...REQUEST,
        responseFormat: {
          kind: 'json-schema',
          name: 'answer',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      }),
  );
  const generation = captured?.['generationConfig'] as Record<string, unknown> | undefined;
  assert.strictEqual(generation?.['responseMimeType'], 'application/json');
  assert.deepStrictEqual(generation?.['responseJsonSchema'], {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  });
});

test('思考签名：functionCall.thoughtSignature 解析并在下一轮原样回传（E2）', async () => {
  const model = new GeminiModel(BASE_CONFIG);
  const sse =
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_sig","name":"shell","args":{"command":"ls"},"thoughtSignature":"ts-123"}}]},"finishReason":"STOP"}]}\n\n';
  const output = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () => model.stream(REQUEST, { onText: () => undefined }),
  );
  assert.strictEqual(output.toolCalls?.[0]?.thoughtSignature, 'ts-123');

  let captured: Record<string, unknown> = {};
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    },
    () =>
      model.generate({
        ...REQUEST,
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_sig',
                name: 'shell',
                arguments: { command: 'ls' },
                thoughtSignature: 'ts-123',
              },
            ],
          },
          { role: 'tool', content: 'ok', toolCallId: 'call_sig' },
          { role: 'user', content: '继续' },
        ],
      }),
  );
  const contents = captured['contents'] as
    { role?: string; parts?: { functionCall?: { thoughtSignature?: string } }[] }[] | undefined;
  const assistant = contents?.find((entry) => entry.role === 'model');
  assert.strictEqual(
    assistant?.parts?.[0]?.functionCall?.thoughtSignature,
    'ts-123',
    '下一轮请求必须原样回传 thoughtSignature',
  );
});
