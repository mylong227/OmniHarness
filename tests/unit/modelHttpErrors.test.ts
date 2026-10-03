// 2026-10-03 审计清偿（D1/D3/D4/D6/D7/D9/D10）：共享 HTTP 错误映射 + 流中错误显式化 +
// 流式重试 fail-fast + 熔断不把取消计为故障 + SSE CRLF 分帧 + 退避可取消。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelHttpErrors } from '../../src/adapters/model/modelHttpErrors.js';
import { SseParser } from '../../src/adapters/model/sseParser.js';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { RetryingModel, DEFAULT_RETRY_POLICY } from '../../src/adapters/model/retryingModel.js';
import { CircuitBreaker } from '../../src/util/concurrency/circuitBreaker.js';
import { ModelCallError } from '../../src/ports/model/model.js';
import type {
  ModelPort,
  ModelRequest,
  ModelOutput,
  StreamCallbacks,
} from '../../src/ports/model/model.js';

/**
 * 临时替换全局 fetch。
 * @param handler 替身 fetch 处理器（url, init）。
 * @param fn 替换期间执行的函数体。
 * @returns fn 的解析值（结束后恢复原 fetch）。
 */
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

/**
 * 把文本包装为字节流。
 * @param text 文本内容。
 * @returns 一次性发出全部字节的流。
 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** 最小测试请求。 */
const request: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

test('ModelHttpErrors.retryableOf：429/408/409/5xx 可重试，其余不可', () => {
  assert.strictEqual(ModelHttpErrors.retryableOf(429), true);
  assert.strictEqual(ModelHttpErrors.retryableOf(408), true);
  assert.strictEqual(ModelHttpErrors.retryableOf(409), true);
  assert.strictEqual(ModelHttpErrors.retryableOf(500), true);
  assert.strictEqual(ModelHttpErrors.retryableOf(529), true);
  assert.strictEqual(ModelHttpErrors.retryableOf(400), false);
  assert.strictEqual(ModelHttpErrors.retryableOf(401), false);
});

test('ModelHttpErrors.parseRetryAfter：秒数与 HTTP 日期两态', () => {
  assert.strictEqual(ModelHttpErrors.parseRetryAfter('2'), 2000);
  assert.strictEqual(ModelHttpErrors.parseRetryAfter('not-a-date'), undefined);
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = ModelHttpErrors.parseRetryAfter(future) ?? -1;
  assert.ok(ms > 0 && ms <= 10_000, '日期形态应解析为到该时刻的毫秒差');
});

test('ModelHttpErrors.streamError：overloaded→529、rate limit→429（均可重试）', () => {
  assert.strictEqual(ModelHttpErrors.streamError('X', 'overloaded_error', '').status, 529);
  assert.strictEqual(ModelHttpErrors.streamError('X', 'rate_limit_error', '').status, 429);
  assert.strictEqual(ModelHttpErrors.streamError('X', 'api_error', '').retryable, true);
});

test('Anthropic：HTTP 429 抛结构化可重试错误（2026-10-03 修 D1：裸 Error 永不重试）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'k',
    model: 'claude-sonnet-4-5',
  });
  let captured: unknown;
  await assert.rejects(
    () =>
      withFetch(
        async () =>
          new Response('{"error":{"message":"rate limited"}}', {
            status: 429,
            headers: { 'retry-after': '3' },
          }),
        () => model.generate(request),
      ),
    (e: unknown) => {
      captured = e;
      return e instanceof ModelCallError;
    },
  );
  const err = captured as ModelCallError;
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.retryAfterMs, 3000);
});

test('Anthropic：流中 error 事件中断流并上抛（2026-10-03 修 D3：半截输出不再被当成功）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'k',
    model: 'claude-sonnet-4-5',
  });
  const sse = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半截"}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
  ].join('');
  let captured: unknown;
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response(streamOf(sse), { status: 200 }),
        () => model.stream(request, { onText: () => {} }),
      ),
    (e: unknown) => {
      captured = e;
      return e instanceof ModelCallError;
    },
  );
  const err = captured as ModelCallError;
  assert.strictEqual(err.retryable, true);
  assert.match(err.message, /overloaded_error|Overloaded/);
});

test('OpenAI 兼容：流中 {"error":…} 负载上抛结构化错误（2026-10-03 修 D3）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'deepseek-chat',
  });
  const sse = [
    'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
    'data: {"error":{"code":"server_error","message":"upstream crashed"}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  let captured: unknown;
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response(streamOf(sse), { status: 200 }),
        () => model.stream(request, { onText: () => {} }),
      ),
    (e: unknown) => {
      captured = e;
      return e instanceof ModelCallError && e.retryable;
    },
  );
  assert.match((captured as ModelCallError).message, /server_error|upstream crashed/);
});

test('OpenAI 兼容：同一 delta 同发 content + tool_calls 时两者都保留（2026-10-03 修 D7）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
  });
  const sse =
    'data: {"choices":[{"delta":{"content":"说明文字","tool_calls":[{"index":0,"id":"c1","function":{"name":"shell","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n' +
    'data: [DONE]\n\n';
  const texts: string[] = [];
  const output = await withFetch(
    async () => new Response(streamOf(sse), { status: 200 }),
    () =>
      model.stream(request, {
        onText: (t) => texts.push(t),
      }),
  );
  assert.deepStrictEqual(texts, ['说明文字'], '同 delta 的文本不得被工具分支早退丢弃');
  assert.strictEqual(output.toolCalls?.[0]?.name, 'shell');
});

test('SseParser：CRLF 分帧与裸 CR 行终止都按 SSE 规范处理（2026-10-03 修 D9）', async () => {
  const parser = new SseParser();
  const events: string[] = [];
  await parser.read(streamOf('data: {"a":1}\r\ndata: {"b":2}\r\n\r\ndata: {"c":3}\r\r'), (event) =>
    events.push(event.data),
  );
  assert.deepStrictEqual(events, ['{"a":1}\n{"b":2}', '{"c":3}']);
});

/**
 * 会先回调增量再抛可重试错误的流式假模型工厂（复现「重试重复投递」场景）。
 * @returns port 假模型端口；calls 读取当前被调用次数。
 */
function flakyStreamModel(): { readonly port: ModelPort; readonly calls: () => number } {
  let calls = 0;
  const port: ModelPort = {
    /** 端口名（端口契约）。 */
    name: 'flaky-stream',
    /** 空实现（本用例不走 generate）。
     * @returns 空文本输出。
     */
    async generate(): Promise<ModelOutput> {
      return { text: '' };
    },
    /** 首次投递增量后抛可重试错误，其后成功返回完整文本。
     * @param _request 模型请求（不消费）。
     * @param callbacks 流式回调（onText 投递前缀）。
     * @returns 第二次起的完整输出。
     */
    async stream(_request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
      calls += 1;
      callbacks.onText('前缀文本');
      if (calls === 1) {
        throw new ModelCallError('terminated', { retryable: true });
      }
      return { text: '完整文本' };
    },
  };
  return { port, calls: () => calls };
}

test('RetryingModel：流式已投递增量后仍重试并交付完整输出（2026-10-03 审计 D4 权衡：保住回合成功，终端重复为已登记的观感代价）', async () => {
  const { port, calls } = flakyStreamModel();
  const wrapped = new RetryingModel(
    port,
    { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
    async () => {},
  );
  const texts: string[] = [];
  const stream = wrapped.stream;
  assert.ok(stream !== undefined, '内层有 stream ⇒ 装饰后必须暴露 stream');
  const out = await stream.call(wrapped, request, { onText: (t: string) => texts.push(t) });
  assert.strictEqual(calls(), 2, '重试发生');
  assert.strictEqual(out.text, '完整文本', '核心循环拿到的是第二次尝试的完整输出');
  assert.deepStrictEqual(
    texts,
    ['前缀文本', '前缀文本'],
    'live sink 会收到两次增量（观感代价，如实钉住）',
  );
});

/** 每次都抛可重试错误的假模型。 */
class AlwaysFailModel implements ModelPort {
  /** 端口名（端口契约）。 */
  public readonly name = 'always-fail';
  /** 已被调用的次数（断言重试行为用）。 */
  public calls = 0;

  /** 每次调用都抛可重试 429。
   * @returns 永不正常返回（恒抛错）。
   */
  public async generate(): Promise<ModelOutput> {
    this.calls += 1;
    throw new ModelCallError('HTTP 429', { status: 429, retryable: true });
  }
}

test('RetryingModel：退避等待期间信号置位即时取消（2026-10-03 修 D10）', async () => {
  const controller = new AbortController();
  const inner = new AlwaysFailModel();
  const wrapped = new RetryingModel(
    inner,
    { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
    async () => {
      // 第一次退避等待时按下「停止」。
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  );
  let caught: unknown;
  try {
    await wrapped.generate({ ...request, signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, '必须抛错（AbortError）');
  assert.strictEqual((caught as Error).name, 'AbortError');
  assert.match((caught as Error).message, /取消|Abort/);
  assert.strictEqual(inner.calls, 1, '取消后不得再发起尝试');
});

test('CircuitBreaker：AbortError 不计入失败（2026-10-03 修 D6：取消不是模型健康度事件）', async () => {
  const breaker = new CircuitBreaker('t', { failureThreshold: 2, openMs: 10_000 });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () =>
        breaker.execute(async () => {
          const abort = new Error('This operation was aborted');
          abort.name = 'AbortError';
          throw abort;
        }),
      (e: Error) => e.name === 'AbortError',
    );
  }
  const snap = breaker.snapshot();
  assert.strictEqual(snap.state, 'closed', '连续取消 5 次也不得开路');
  assert.strictEqual(snap.failures, 0);
});
