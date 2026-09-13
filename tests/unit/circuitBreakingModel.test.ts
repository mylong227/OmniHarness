import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreakingModel } from '../../src/adapters/model/circuitBreakingModel.js';
import { RetryingModel } from '../../src/adapters/model/retryingModel.js';
import { CircuitOpenError } from '../../src/errors/circuitOpenError.js';
import { ModelCallError } from '../../src/ports/model/model.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import { CircuitBreaker } from '../../src/util/circuitBreaker.js';

/** 可计数、可控抛错的假模型。 */
class CountingModel implements ModelPort {
  /** 端口名。 */
  public readonly name = 'counting';
  /** 被调用次数。 */
  public calls = 0;
  /**
   * @param fail 是否每次调用都抛错。
   */
  public constructor(private readonly fail: boolean) {}
  /**
   * @param _req 模型请求（忽略）。
   * @returns 成功时返回固定输出；fail 为真时抛 503。
   */
  public async generate(_req: ModelRequest): Promise<ModelOutput> {
    this.calls += 1;
    if (this.fail) {
      throw new ModelCallError('HTTP 503', { status: 503, retryable: true });
    }
    return { text: 'ok' };
  }
}

/** 可推进的假时钟。 */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('透明：成功时透传 name 与输出', async () => {
  const model = new CountingModel(false);
  const wrapper = new CircuitBreakingModel(model, new CircuitBreaker('model'));
  assert.strictEqual(wrapper.name, 'counting');
  assert.deepStrictEqual(await wrapper.generate({ messages: [], tools: [] }), { text: 'ok' });
  assert.strictEqual(model.calls, 1);
});

test('内部无 stream 时不定义 stream（不虚假广告）', () => {
  const wrapper = new CircuitBreakingModel(new CountingModel(false), new CircuitBreaker('m'));
  assert.strictEqual(wrapper.stream, undefined);

  const withStream: ModelPort = {
    name: 's',
    generate: async () => ({ text: 'x' }),
    stream: async () => ({ text: 'x' }),
  };
  assert.strictEqual(
    typeof new CircuitBreakingModel(withStream, new CircuitBreaker('m')).stream,
    'function',
  );
});

test('连续失败达阈值后开路：开路期抛 CircuitOpenError 且内部模型零调用', async () => {
  const clock = fakeClock();
  const model = new CountingModel(true);
  const breaker = new CircuitBreaker('model', {
    failureThreshold: 2,
    openMs: 1000,
    now: clock.now,
  });
  const wrapper = new CircuitBreakingModel(model, breaker);

  await assert.rejects(() => wrapper.generate({ messages: [], tools: [] }), /HTTP 503/);
  await assert.rejects(() => wrapper.generate({ messages: [], tools: [] }), /HTTP 503/);
  assert.strictEqual(breaker.currentState, 'open');
  assert.strictEqual(model.calls, 2);

  await assert.rejects(
    () => wrapper.generate({ messages: [], tools: [] }),
    (err: unknown) => err instanceof CircuitOpenError,
  );
  assert.strictEqual(model.calls, 2, '开路期不得触达内部模型');
});

test('组合语义：熔断包在重试外——一次 generate 内的全部重试只计一次熔断失败', async () => {
  const clock = fakeClock();
  const model = new CountingModel(true);
  // 内层重试 3 次（全部失败），外层熔断阈值 3：需要 3 次逻辑调用才开路。
  const retrying = new RetryingModel(
    model,
    { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    async () => undefined,
  );
  const breaker = new CircuitBreaker('model', {
    failureThreshold: 3,
    openMs: 1000,
    now: clock.now,
  });
  const wrapper = new CircuitBreakingModel(retrying, breaker);

  await assert.rejects(() => wrapper.generate({ messages: [], tools: [] }));
  assert.strictEqual(model.calls, 3, '一次逻辑调用 = 内层 3 次重试');
  assert.strictEqual(breaker.snapshot().failures, 1, '整段重试只计 1 次熔断失败');
  assert.strictEqual(breaker.currentState, 'closed');

  await assert.rejects(() => wrapper.generate({ messages: [], tools: [] }));
  assert.strictEqual(breaker.snapshot().failures, 2);
  await assert.rejects(() => wrapper.generate({ messages: [], tools: [] }));
  assert.strictEqual(breaker.currentState, 'open');
  assert.strictEqual(model.calls, 9);
});

test('冷却后半开探测：成功即复位并可继续服务', async () => {
  const clock = fakeClock();
  let down = true;
  const model: ModelPort = {
    name: 'toggle',
    generate: async () => {
      if (down) {
        throw new ModelCallError('HTTP 503', { status: 503, retryable: true });
      }
      return { text: 'recovered' };
    },
  };
  const breaker = new CircuitBreaker('model', {
    failureThreshold: 1,
    openMs: 100,
    now: clock.now,
  });
  const wrapper = new CircuitBreakingModel(model, breaker);

  await assert.rejects(() => wrapper.generate({ messages: [], tools: [] }));
  assert.strictEqual(breaker.currentState, 'open');
  clock.advance(100);
  down = false;
  assert.deepStrictEqual(await wrapper.generate({ messages: [], tools: [] }), {
    text: 'recovered',
  });
  assert.strictEqual(breaker.currentState, 'closed');
});

test('stream 路径同样受熔断保护', async () => {
  const clock = fakeClock();
  const model: ModelPort = {
    name: 's',
    generate: async () => ({ text: 'x' }),
    stream: async () => {
      throw new ModelCallError('HTTP 503', { status: 503, retryable: true });
    },
  };
  const breaker = new CircuitBreaker('model', { failureThreshold: 1, openMs: 50, now: clock.now });
  const wrapper = new CircuitBreakingModel(model, breaker);

  await assert.rejects(
    () => wrapper.stream!({ messages: [], tools: [] }, { onText: () => undefined }),
    /HTTP 503/,
  );
  assert.strictEqual(breaker.currentState, 'open');
  await assert.rejects(
    () => wrapper.stream!({ messages: [], tools: [] }, { onText: () => undefined }),
    (err: unknown) => err instanceof CircuitOpenError,
  );
});
