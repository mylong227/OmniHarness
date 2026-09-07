import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, backoffMs } from '../../src/util/retry.js';

test('withRetry：首次成功不重试', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      return 'ok';
    },
    { maxAttempts: 3 },
  );
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry：失败后按次数重试直至成功', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error(' transient');
      }
      return 'recovered';
    },
    { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} },
  );
  assert.strictEqual(result, 'recovered');
  assert.strictEqual(calls, 3);
});

test('withRetry：不可重试错误立即抛出（不耗预算）', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('4xx auth failed');
      },
      {
        maxAttempts: 5,
        isRetryable: (e) => /5\d\d|network/i.test((e as Error).message),
        sleep: async () => {},
      },
    ),
  );
  assert.strictEqual(calls, 1, '不可重试错误应只调用一次');
});

test('withRetry：超过最大次数抛出最后错误', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('network down');
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} },
    ),
  );
  assert.strictEqual(calls, 2);
});

test('backoffMs：指数增长且封顶 maxDelayMs', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000, factor: 2 };
  assert.ok(backoffMs(1, opts) <= 1000);
  assert.ok(backoffMs(10, opts) <= 1000, '第 10 次退避应被封顶');
});
