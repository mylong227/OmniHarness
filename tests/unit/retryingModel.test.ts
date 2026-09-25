import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryingModel, DEFAULT_RETRY_POLICY } from '../../src/adapters/model/retryingModel.js';
import { ModelCallError } from '../../src/ports/model/model.js';
import type { ModelPort, ModelRequest, ModelOutput } from '../../src/ports/model/model.js';

/** 可计数、可控抛错的假模型。 */
class FlakyModel implements ModelPort {
  public readonly name = 'flaky';
  public calls = 0;
  /** 第几次调用开始返回成功（Infinity 表示永不成功）。 */
  public constructor(
    private readonly succeedFrom: number,
    private readonly errorFactory: () => Error,
  ) {}
  public async generate(_req: ModelRequest): Promise<ModelOutput> {
    this.calls += 1;
    if (this.calls >= this.succeedFrom) {
      return { text: 'ok' };
    }
    throw this.errorFactory();
  }
}

/** 429 限流错误。 */
function throttle(): Error {
  return new ModelCallError('HTTP 429', { status: 429, retryable: true });
}

/** 400 客户端错误（不可重试）。 */
function badRequest(): Error {
  return new ModelCallError('HTTP 400', { status: 400, retryable: false });
}

/** 收集每次等待毫秒的 no-op delay。 */
function spyDelay(): { fn: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    fn: async (ms: number) => {
      waits.push(ms);
    },
    waits,
  };
}

test('重试：429 在达到上限前成功，仅重试必要次数', async () => {
  const delay = spyDelay();
  const model = new FlakyModel(3, throttle);
  const wrapped = new RetryingModel(model, { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 }, delay.fn);
  const out = await wrapped.generate({ messages: [], tools: [] });
  assert.strictEqual(out.text, 'ok');
  assert.strictEqual(model.calls, 3);
  assert.strictEqual(delay.waits.length, 2);
});

test('重试：始终 429 时耗尽 maxAttempts 后上抛', async () => {
  const delay = spyDelay();
  const model = new FlakyModel(Infinity, throttle);
  const wrapped = new RetryingModel(model, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, delay.fn);
  await assert.rejects(() => wrapped.generate({ messages: [], tools: [] }), /HTTP 429/);
  assert.strictEqual(model.calls, 3);
  assert.strictEqual(delay.waits.length, 2);
});

test('不重试：400 客户端错误立即上抛，不等待', async () => {
  const delay = spyDelay();
  const model = new FlakyModel(Infinity, badRequest);
  const wrapped = new RetryingModel(model, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, delay.fn);
  await assert.rejects(() => wrapped.generate({ messages: [], tools: [] }), /HTTP 400/);
  assert.strictEqual(model.calls, 1);
  assert.strictEqual(delay.waits.length, 0);
});

test('Retry-After：优先采用服务端建议等待，不叠加指数退避', async () => {
  const delay = spyDelay();
  let first = true;
  const model: ModelPort = {
    name: 'once',
    async generate() {
      if (first) {
        first = false;
        throw new ModelCallError('HTTP 429', { status: 429, retryable: true, retryAfterMs: 7000 });
      }
      return { text: 'ok' };
    },
  };
  const wrapped = new RetryingModel(model, { ...DEFAULT_RETRY_POLICY, maxAttempts: 4 }, delay.fn);
  const out = await wrapped.generate({ messages: [], tools: [] });
  assert.strictEqual(out.text, 'ok');
  assert.deepStrictEqual(delay.waits, [7000]);
});

test('透明：成功时不改变输出与 name', async () => {
  const model: ModelPort = { name: 'inner', generate: async () => ({ text: 'hi' }) };
  const wrapped = new RetryingModel(model);
  assert.strictEqual(wrapped.name, 'inner');
  assert.deepStrictEqual(await wrapped.generate({ messages: [], tools: [] }), { text: 'hi' });
});

test('isRetryable：结构化错误以 retryable 为准', () => {
  assert.strictEqual(
    RetryingModel.isRetryable(new ModelCallError('x', { status: 503, retryable: true })),
    true,
  );
  assert.strictEqual(
    RetryingModel.isRetryable(new ModelCallError('x', { status: 404, retryable: false })),
    false,
  );
});

test('isRetryable：duck-typing 兜底（无 ModelCallError）', () => {
  assert.strictEqual(RetryingModel.isRetryable({ status: 429 }), true);
  assert.strictEqual(RetryingModel.isRetryable({ status: 500 }), true);
  assert.strictEqual(RetryingModel.isRetryable({ status: 400 }), false);
  assert.strictEqual(RetryingModel.isRetryable({ code: 'ECONNRESET' }), true);
  assert.strictEqual(RetryingModel.isRetryable({ message: 'fetch failed' }), true);
  assert.strictEqual(RetryingModel.isRetryable(new Error('boom')), false);
});
