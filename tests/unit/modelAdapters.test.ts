import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseParser } from '../../src/adapters/model/sseParser.js';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  OpenAiCompatibleModel,
  REQUEST_TIMEOUT_ENV_KEY,
} from '../../src/adapters/model/openAiCompatibleModel.js';
import { ModelCallError } from '../../src/ports/model/model.js';
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

/** 测试请求。 */
const request: ModelRequest = {
  messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ],
  tools: [
    { name: 'shell', description: '执行命令', parameters: { type: 'object', properties: {} } },
  ],
};

test('SSE 解析：多事件块拆分', async () => {
  const events: string[] = [];
  const text = ['data: {"a":1}\n\ndata: {"b":2}\n\n'];
  await sseParser.read(streamOf(text.join('')), (event) => events.push(event.data));
  assert.deepStrictEqual(events, ['{"a":1}', '{"b":2}']);
});

test('SSE 解析：event 字段与跨块 data 行', async () => {
  const events: string[] = [];
  await sseParser.read(streamOf('event: delta\ndata: line1\ndata: line2\n\n'), (event) => {
    events.push(`${event.event}:${event.data}`);
  });
  assert.deepStrictEqual(events, ['delta:line1\nline2']);
});

test('Anthropic：请求体拆分 system 与工具格式', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    model: 'claude-3',
  });
  let captured: { url: string; init: RequestInit } | undefined;
  await withFetch(
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      });
    },
    () => model.generate(request),
  );

  assert.strictEqual(captured?.url, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>;
  // V2.1（C10 prompt caching）：system 变为独立 text block 并带 ephemeral 缓存断点。
  assert.deepStrictEqual(body['system'], [
    { type: 'text', text: '你是助手', cache_control: { type: 'ephemeral' } },
  ]);
  assert.strictEqual((body['messages'] as { role: string }[])[0]?.role, 'user');
  assert.strictEqual((body['tools'] as { name: string }[])[0]?.name, 'shell');
  assert.strictEqual(
    (body['tools'] as { input_schema: unknown }[])[0]?.input_schema !== undefined,
    true,
  );
  const headers = captured?.init.headers as Record<string, string>;
  assert.strictEqual(headers['x-api-key'], 'sk-test');
  assert.strictEqual(headers['anthropic-version'], '2023-06-01');
});

test('Anthropic：响应解析文本与工具调用', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'claude-3',
  });
  const body = {
    content: [
      { type: 'text', text: '我来执行' },
      { type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } },
    ],
  };
  const output = await withFetch(
    async () => new Response(JSON.stringify(body), { status: 200 }),
    () => model.generate(request),
  );
  assert.strictEqual(output.text, '我来执行');
  assert.strictEqual(output.toolCalls?.[0]?.id, 't1');
  assert.strictEqual(output.toolCalls?.[0]?.arguments['command'], 'ls');
});

test('Anthropic：流式文本增量回调', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'claude-3',
  });
  const sse = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"世界"}}\n\n',
  ].join('');
  const chunks: string[] = [];
  const output = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () => model.stream(request, { onText: (text) => chunks.push(text) }),
  );
  assert.deepStrictEqual(chunks, ['你好', '世界']);
  assert.strictEqual(output.text, '你好世界');
});

test('OpenAI 兼容：流式文本增量回调', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
  });
  const sse = [
    'data: {"choices":[{"delta":{"content":"星"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"辰"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const chunks: string[] = [];
  const output = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () => model.stream(request, { onText: (text) => chunks.push(text) }),
  );
  assert.deepStrictEqual(chunks, ['星', '辰']);
  assert.strictEqual(output.text, '星辰');
});

test('OpenAI 兼容：非流式生成保持可用', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
  });
  const body = { choices: [{ message: { role: 'assistant', content: '回答', tool_calls: [] } }] };
  const output = await withFetch(
    async () => new Response(JSON.stringify(body), { status: 200 }),
    () => model.generate(request),
  );
  assert.strictEqual(output.text, '回答');
});

test('OpenAI 兼容：assistant reasoning_content 回传 + 空 reasoning_effort 不发（DeepSeek 400 防御）', async () => {
  let captured: Record<string, unknown> | undefined;
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
  });
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    () =>
      model.generate({
        messages: [
          { role: 'user', content: '读文件' },
          {
            role: 'assistant',
            content: '',
            reasoningContent: '我要读文件',
            toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }],
          },
          { role: 'tool', content: 'ok', toolCallId: 'c1' },
        ],
        tools: [
          { name: 'read_file', description: '读', parameters: { type: 'object', properties: {} } },
        ],
        reasoningEffort: '',
      }),
  );
  const messages = captured?.['messages'] as Array<Record<string, unknown>>;
  assert.strictEqual(messages[1]?.['reasoning_content'], '我要读文件');
  assert.strictEqual(
    'reasoning_effort' in (captured ?? {}),
    false,
    '空 reasoning_effort 不得进入请求体',
  );
});

test('OpenAI 兼容：空串 reasoning_content 也进入请求体（OBS-6 思考模式一致性防御）', async () => {
  let captured: Record<string, unknown> | undefined;
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
  });
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    () =>
      model.generate({
        messages: [
          { role: 'user', content: '读文件' },
          {
            role: 'assistant',
            content: '',
            reasoningContent: '我要读文件',
            toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }],
          },
          { role: 'tool', content: 'ok', toolCallId: 'c1' },
          // 思考模式后续回合：模型未返回 reasoning，但必须带 reasoning_content 字段（空串占位）
          { role: 'assistant', content: '继续', reasoningContent: '' },
        ],
        tools: [
          { name: 'read_file', description: '读', parameters: { type: 'object', properties: {} } },
        ],
        reasoningEffort: '',
      }),
  );
  const messages = captured?.['messages'] as Array<Record<string, unknown>>;
  // 关键回归：空串占位必须原样发送，否则 DeepSeek 思考模式报 HTTP 400 "must be passed back"。
  assert.strictEqual(messages[3]?.['reasoning_content'], '');
  assert.strictEqual('reasoning_content' in (messages[3] ?? {}), true);
});

test('OpenAI 兼容：thinking + tool_calls + reasoningContent=undefined 强制注入 reasoning_content:""（OBS-7 兜底）', async () => {
  // #OBS-7 回归：复现 2026-09-07 线上 bug——历史 assistant 消息 reasoningContent 为
  // undefined（流式未返回 reasoning 段、或消息生成于启用思考前）且带 tool_calls，
  // 当前请求又开启 thinking → DeepSeek v4 下一轮报 "must be passed back" HTTP 400。
  // 兜底逻辑：thinking 模式下，对带 tool_calls 且 reasoningContent 缺失的 assistant
  // 消息强制注入 reasoning_content:"" 占位。
  let captured: Record<string, unknown> | undefined;
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
  });
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    () =>
      model.generate({
        messages: [
          { role: 'user', content: '写文件' },
          {
            // 关键：reasoningContent 不设（流式没返回 reasoning，或生成于思考模式开启前）
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a' } }],
          },
          { role: 'tool', content: 'ok', toolCallId: 'c1' },
        ],
        tools: [
          { name: 'write_file', description: '写', parameters: { type: 'object', properties: {} } },
        ],
        reasoningEffort: 'high', // 思考模式已开启
      }),
  );
  const messages = captured?.['messages'] as Array<Record<string, unknown>>;
  // 兜底：即使 reasoningContent 缺，也必须注入空串占位
  assert.strictEqual(
    'reasoning_content' in (messages[1] ?? {}),
    true,
    'thinking + tool_calls 下 reasoning_content 字段必须存在（兜底空串）',
  );
  assert.strictEqual(messages[1]?.['reasoning_content'], '');
});

test('OpenAI 兼容：thinking 关 + tool_calls + reasoningContent=undefined 不注入 reasoning_content（OpenAI 端点兼容）', async () => {
  // 对照组：thinking 未开启时，reasoningContent 缺就完全不注入该字段——保持与 OpenAI、
  // 以及其他非思考模式端点的兼容性（它们没有 reasoning_content 字段，强加会破坏请求体）。
  let captured: Record<string, unknown> | undefined;
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk',
    model: 'gpt-4o-mini',
  });
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    () =>
      model.generate({
        messages: [
          { role: 'user', content: '写文件' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a' } }],
          },
          { role: 'tool', content: 'ok', toolCallId: 'c1' },
        ],
        tools: [
          { name: 'write_file', description: '写', parameters: { type: 'object', properties: {} } },
        ],
        // 思考模式未开启（reasoningEffort 未设）
      }),
  );
  const messages = captured?.['messages'] as Array<Record<string, unknown>>;
  assert.strictEqual(
    'reasoning_content' in (messages[1] ?? {}),
    false,
    'thinking 关时 reasoningContent 缺不应注入 reasoning_content 字段',
  );
});

test('OpenAI 兼容：非空 reasoning_effort 透传', async () => {
  let captured: Record<string, unknown> | undefined;
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
  });
  await withFetch(
    async (_url, init) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    () =>
      model.generate({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        reasoningEffort: 'high',
      }),
  );
  assert.strictEqual(captured?.['reasoning_effort'], 'high');
  assert.strictEqual('tools' in (captured ?? {}), false, '空工具列表不得发 tools 字段');
});

/** 假 fetch：模拟「服务端接受连接后永不回包」——自身永不 settle，仅在 signal 中止时 reject。 */
function stalledFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === undefined || signal === null) {
      return; // 完全无信号 ⇒ 与改造前的裸 fetch 行为一致：永久挂起
    }
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('OpenAI 兼容：空闲超时把「永不回包」收敛为可重试错误（关二·修复）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 150,
  });
  const started = Date.now();
  const err: unknown = await withFetch(stalledFetch, () => model.generate(request)).then(
    () => undefined,
    (e: unknown) => e,
  );
  const elapsed = Date.now() - started;
  assert.ok(err instanceof ModelCallError, `应抛 ModelCallError，实际 ${String(err)}`);
  assert.strictEqual(err.retryable, true, '必须可重试，否则 RetryingModel 仍兜不住');
  assert.ok(elapsed < 3000, `须快速有界失败（实测 ${elapsed}ms）；改造前此处会无限期挂死`);
});

test('OpenAI 兼容：关闭空闲超时后同样的挂起不再中止（关一·对照）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 0,
  });
  const outcome = await withFetch(stalledFetch, () =>
    Promise.race([
      model.generate(request).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 500)),
    ]),
  );
  assert.strictEqual(
    outcome,
    'still-pending',
    '关闭后不得自行中止 —— 该对照证明「开」与「关」行为确实不同（非死旋钮）',
  );
});

test('OpenAI 兼容：流式「中途静默」被空闲超时中止（流式关二）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 150,
  });
  const encoder = new TextEncoder();
  const handler = (_url: string, init: RequestInit): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"甲"}}]}\n\n'));
        // 之后彻底静默；中止时把流打错，模拟真实 fetch 对被中止响应体的处理。
        init.signal?.addEventListener(
          'abort',
          () => {
            try {
              controller.error(new Error('aborted'));
            } catch {
              // 流可能已结束：忽略
            }
          },
          { once: true },
        );
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const chunks: string[] = [];
  const err: unknown = await withFetch(handler, () =>
    model.stream(request, { onText: (text) => chunks.push(text) }),
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.deepStrictEqual(chunks, ['甲'], '首个事件应已送达（证明静默前确有进展）');
  assert.ok(err instanceof ModelCallError, `应抛 ModelCallError，实际 ${String(err)}`);
  assert.strictEqual(err.retryable, true);
});

test('OpenAI 兼容：流式慢但有进展不被误杀（空闲语义 ≠ 总时限）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 200,
  });
  const encoder = new TextEncoder();
  const handler = (): Promise<Response> => {
    const frames = ['甲', '乙', '丙', '丁'];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          await new Promise((resolve) => setTimeout(resolve, 90));
          controller.enqueue(
            encoder.encode(`data: {"choices":[{"delta":{"content":"${frame}"}}]}\n\n`),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const chunks: string[] = [];
  const output = await withFetch(handler, () =>
    model.stream(request, { onText: (text) => chunks.push(text) }),
  );
  // 总耗时 4×90=360ms > 200ms 阈值，但每次间隔 90ms < 阈值 ⇒ 空闲语义下必须活下来。
  assert.deepStrictEqual(chunks, ['甲', '乙', '丙', '丁']);
  assert.strictEqual(output.text, '甲乙丙丁');
});

test('OpenAI 兼容：空闲超时解析优先级 显式 > env > 库级默认（env 非法不静默变 NaN）', () => {
  const previous = process.env[REQUEST_TIMEOUT_ENV_KEY];
  try {
    delete process.env[REQUEST_TIMEOUT_ENV_KEY];
    assert.strictEqual(
      new OpenAiCompatibleModel({ baseUrl: 'u', apiKey: 'k', model: 'm' }).requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      '未显式、无 env ⇒ 取库级默认（这正是本次补掉的缺口）',
    );
    process.env[REQUEST_TIMEOUT_ENV_KEY] = '1234';
    assert.strictEqual(
      new OpenAiCompatibleModel({ baseUrl: 'u', apiKey: 'k', model: 'm' }).requestTimeoutMs,
      1234,
      'env 可覆盖库级默认（运维不改进代码即可调；0/负数=关闭）',
    );
    assert.strictEqual(
      new OpenAiCompatibleModel({ baseUrl: 'u', apiKey: 'k', model: 'm', requestTimeoutMs: 77 })
        .requestTimeoutMs,
      77,
      '显式配置优先于 env',
    );
    process.env[REQUEST_TIMEOUT_ENV_KEY] = 'not-a-number';
    assert.strictEqual(
      new OpenAiCompatibleModel({ baseUrl: 'u', apiKey: 'k', model: 'm' }).requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'env 非法时回落默认；若静默变 NaN，则 idleMs > 0 判据被击穿、守卫会被悄悄关掉',
    );
  } finally {
    if (previous === undefined) {
      delete process.env[REQUEST_TIMEOUT_ENV_KEY];
    } else {
      process.env[REQUEST_TIMEOUT_ENV_KEY] = previous;
    }
  }
});

test('OpenAI 兼容：关闭空闲超时且无调用方信号时不带 signal（零行为变更）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 0,
  });
  let captured: RequestInit | undefined;
  await withFetch(
    async (_url, init) => {
      captured = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    () => model.generate(request),
  );
  assert.strictEqual('signal' in (captured ?? {}), false, '关闭后须逐字回到改造前行为');
});

test('OpenAI 兼容：开启空闲超时时调用方取消仍能穿透守卫到达 fetch', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 5_000,
  });
  const controller = new AbortController();
  let captured: RequestInit | undefined;
  let release: (() => void) | undefined;
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withFetch(
    async (_url, init) => {
      captured = init;
      // 让请求停在「已发出、未返回」的状态：取消语义只有**在飞期间**才有意义。
      await inFlight;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      );
    },
    async () => {
      const running = model.generate({ ...request, signal: controller.signal });
      // 等到 fetch 真的被调用（signal 已捕获）再取消。
      for (let i = 0; i < 200 && captured === undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.strictEqual(captured?.signal instanceof AbortSignal, true, 'signal 仍须传给 fetch');
      assert.strictEqual(captured?.signal?.aborted, false);
      controller.abort();
      assert.strictEqual(captured?.signal?.aborted, true, '在飞期间调用方取消语义不得被守卫吞掉');
      release?.();
      await running;
    },
  );
  // 请求收尾后守卫会摘掉转发器（这正是「长寿命取消令牌上不留监听器」的修复）：
  // 此时再取消**不应**再影响已完成的请求——下面这条断言把该新语义钉住。
  controller.abort();
  assert.strictEqual(captured?.signal?.aborted, true, '收尾后信号状态不应回退');
});
