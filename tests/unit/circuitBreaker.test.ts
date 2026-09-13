import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitOpenError } from '../../src/errors/circuitOpenError.js';
import { CircuitBreaker } from '../../src/util/circuitBreaker.js';

/** 可推进的假时钟（测试禁用真实睡眠）。 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('closed：正常放行且连续成功不开路', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('t', { now: clock.now });
  assert.strictEqual(breaker.currentState, 'closed');
  for (let i = 0; i < 10; i += 1) {
    const r = await breaker.execute(async () => i);
    assert.strictEqual(r, i);
  }
  assert.strictEqual(breaker.currentState, 'closed');
  assert.strictEqual(breaker.snapshot().failures, 0);
});

test('连续失败达阈值即开路，且开路期内不执行 fn（fail-closed）', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('model', {
    failureThreshold: 3,
    openMs: 1000,
    now: clock.now,
  });
  let calls = 0;
  const failing = async (): Promise<void> => {
    calls += 1;
    throw new Error('boom');
  };
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => breaker.execute(failing), /boom/);
  }
  assert.strictEqual(breaker.currentState, 'open');
  assert.strictEqual(calls, 3);

  // 开路期内：抛 CircuitOpenError，且 fn 绝不被调用。
  await assert.rejects(
    () => breaker.execute(failing),
    (err: unknown) => err instanceof CircuitOpenError && err.breaker === 'model',
  );
  assert.strictEqual(calls, 3, '开路期不得执行 fn');
  const snap = breaker.snapshot();
  assert.strictEqual(snap.openedAt, 0);
  assert.strictEqual(snap.failures, 3);
});

test('成功打断连续失败：计数清零，不累计到阈值', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('m', { failureThreshold: 3, now: clock.now });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('e'))));
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('e'))));
  await breaker.execute(async () => 'ok');
  assert.strictEqual(breaker.snapshot().failures, 0);
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('e'))));
  assert.strictEqual(breaker.currentState, 'closed', '复位后需重新累计到阈值');
});

test('冷却到期转 half-open，探测成功即复位 closed', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('m', {
    failureThreshold: 1,
    openMs: 500,
    now: clock.now,
  });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('x'))));
  assert.strictEqual(breaker.currentState, 'open');

  clock.advance(499);
  assert.strictEqual(breaker.currentState, 'open', '冷却未到不得半开');
  clock.advance(1);
  assert.strictEqual(breaker.currentState, 'half-open', '冷却到点自动半开');

  const result = await breaker.execute(async () => 'recovered');
  assert.strictEqual(result, 'recovered');
  assert.strictEqual(breaker.currentState, 'closed');
  assert.strictEqual(breaker.snapshot().failures, 0);
});

test('half-open 探测失败：重新开路并从新的时刻重新计时', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('m', {
    failureThreshold: 1,
    openMs: 500,
    now: clock.now,
  });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('x'))));
  clock.advance(500);
  assert.strictEqual(breaker.currentState, 'half-open');

  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('still down'))));
  assert.strictEqual(breaker.currentState, 'open');
  assert.strictEqual(breaker.snapshot().openedAt, 500, '开路时刻应为探测失败时刻');

  clock.advance(499);
  assert.strictEqual(breaker.currentState, 'open', '重新计时后 499ms 仍未到期');
  clock.advance(1);
  assert.strictEqual(breaker.currentState, 'half-open');
});

test('half-open 并发探测名额：默认 1，超出的请求被拒且不执行', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('m', {
    failureThreshold: 1,
    openMs: 100,
    now: clock.now,
  });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('x'))));
  clock.advance(100);

  let resolveProbe: (() => void) | undefined;
  const pending = breaker.execute(
    () =>
      new Promise<string>((res) => {
        resolveProbe = () => res('done');
      }),
  );
  // 半开名额已被首个探测占用，第二个请求立即被拒。
  assert.strictEqual(breaker.allowRequest(), false);
  resolveProbe?.();
  assert.strictEqual(await pending, 'done');
  assert.strictEqual(breaker.currentState, 'closed');
});

test('halfOpenMaxProbes>1：需累计到上限次成功才复位', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('m', {
    failureThreshold: 1,
    openMs: 10,
    halfOpenMaxProbes: 2,
    now: clock.now,
  });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('x'))));
  clock.advance(10);
  assert.strictEqual(breaker.currentState, 'half-open');

  await breaker.execute(async () => 'a');
  assert.strictEqual(breaker.currentState, 'half-open', '第一次成功不足以复位');
  await breaker.execute(async () => 'b');
  assert.strictEqual(breaker.currentState, 'closed');
});

test('状态变更回调按顺序收到跳变', async () => {
  const clock = fakeClock();
  const seen: string[] = [];
  const breaker = new CircuitBreaker('m', {
    failureThreshold: 1,
    openMs: 10,
    now: clock.now,
    onStateChange: (from, to) => seen.push(`${from}->${to}`),
  });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('x'))));
  clock.advance(10);
  assert.strictEqual(breaker.currentState, 'half-open');
  await breaker.execute(async () => 'ok');
  assert.deepStrictEqual(seen, ['closed->open', 'open->half-open', 'half-open->closed']);
});

test('reset：手动复位清零计数并回到 closed', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker('m', { failureThreshold: 1, now: clock.now });
  await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('x'))));
  assert.strictEqual(breaker.currentState, 'open');
  breaker.reset();
  assert.strictEqual(breaker.currentState, 'closed');
  assert.deepStrictEqual(breaker.snapshot(), {
    state: 'closed',
    failures: 0,
    openedAt: undefined,
    halfOpenInFlight: 0,
    halfOpenSuccesses: 0,
  });
});
