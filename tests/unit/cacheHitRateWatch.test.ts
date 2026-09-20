/**
 * 命中率坍塌观测器的测试（缺口 C：命中率掉下去必须有人知道）。
 *
 * 同时验证两件事：
 *  1. **判定**（纯函数）：小样本静默、无分母静默、达标静默、坍塌返回四个数字；
 *  2. **落日志**：坍塌时真的写出 `warn` 级结构化日志（事件名 `model.cache.lowHitRate`），
 *     且**不阻断**调用方——`inspect` 返回值与异常语义都不改变业务结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CacheHitRateWatch,
  DEFAULT_LOW_HIT_RATE_THRESHOLD,
  LOW_HIT_RATE_ENV_KEY,
  LOW_HIT_RATE_EVENT,
  MIN_CALLS_FOR_JUDGEMENT,
} from '../../src/observability/cacheHitRateWatch.js';

/** 采集 warn 日志行（临时接管 process.stderr.write，结束即还原）。 */
function captureStderr<T>(fn: () => T): { readonly lines: string[]; readonly result: T } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = fn();
    return { lines, result };
  } finally {
    process.stderr.write = original;
  }
}

/** 解析采集到的 JSON 日志行。 */
function parseLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('阈值默认值与环境变量覆盖：非法值回落默认值', () => {
  const watch = new CacheHitRateWatch();
  assert.strictEqual(DEFAULT_LOW_HIT_RATE_THRESHOLD, 50);
  // 默认阈值：49.9% 坍塌、50% 不坍塌（边界含等号）。
  assert.ok(
    watch.evaluate({ promptTokens: 1000, cachedPromptTokens: 499, calls: 5, hitRate: 49.9 }),
  );
  assert.strictEqual(
    watch.evaluate({ promptTokens: 1000, cachedPromptTokens: 500, calls: 5, hitRate: 50 }),
    undefined,
  );

  const saved = process.env[LOW_HIT_RATE_ENV_KEY];
  try {
    process.env[LOW_HIT_RATE_ENV_KEY] = '10';
    assert.strictEqual(CacheHitRateWatch.thresholdFromEnv(), 10);
    // 注意：默认参数只在 **未传参** 时读取 env，故这里显式用 env 取值构造（与服务端注入方式一致）。
    const strict = new CacheHitRateWatch(CacheHitRateWatch.thresholdFromEnv());
    // 阈值 10 下 20% 已达标（不告警），10% 仍算坍塌（边界：hitRate >= threshold 视为达标）。
    assert.strictEqual(
      strict.evaluate({ promptTokens: 100, cachedPromptTokens: 20, calls: 9, hitRate: 20 }),
      undefined,
    );
    assert.ok(strict.evaluate({ promptTokens: 100, cachedPromptTokens: 9, calls: 9, hitRate: 9 }));
    process.env[LOW_HIT_RATE_ENV_KEY] = '0';
    assert.strictEqual(CacheHitRateWatch.thresholdFromEnv(), 0);
    for (const bad of ['abc', '-1', '101', 'NaN', 'Infinity', '   ']) {
      process.env[LOW_HIT_RATE_ENV_KEY] = bad;
      assert.strictEqual(
        CacheHitRateWatch.thresholdFromEnv(),
        DEFAULT_LOW_HIT_RATE_THRESHOLD,
        `非法值 ${JSON.stringify(bad)} 应回落默认值`,
      );
    }
    // 空串按「未配置」处理（shell 里 `VAR=` 的常见形态），同样回落默认值。
    process.env[LOW_HIT_RATE_ENV_KEY] = '';
    assert.strictEqual(CacheHitRateWatch.thresholdFromEnv(), DEFAULT_LOW_HIT_RATE_THRESHOLD);
    delete process.env[LOW_HIT_RATE_ENV_KEY];
    assert.strictEqual(CacheHitRateWatch.thresholdFromEnv(), DEFAULT_LOW_HIT_RATE_THRESHOLD);
  } finally {
    if (saved === undefined) delete process.env[LOW_HIT_RATE_ENV_KEY];
    else process.env[LOW_HIT_RATE_ENV_KEY] = saved;
  }
});

test('小样本静默：调用数 < 5 时即使命中率为 0 也不判定', () => {
  const watch = new CacheHitRateWatch();
  for (let calls = 0; calls < MIN_CALLS_FOR_JUDGEMENT; calls += 1) {
    assert.strictEqual(
      watch.evaluate({ promptTokens: 1000, cachedPromptTokens: 0, calls, hitRate: 0 }),
      undefined,
      `calls=${calls} 应静默`,
    );
  }
  assert.ok(watch.evaluate({ promptTokens: 1000, cachedPromptTokens: 0, calls: 5, hitRate: 0 }));
});

test('无分母 / 无命中率静默：promptTokens=0 或 hitRate 缺省不判定', () => {
  const watch = new CacheHitRateWatch();
  assert.strictEqual(
    watch.evaluate({ promptTokens: 0, cachedPromptTokens: 0, calls: 9 }),
    undefined,
  );
  assert.strictEqual(
    watch.evaluate({ promptTokens: 0, cachedPromptTokens: 0, calls: 9, hitRate: 0 }),
    undefined,
  );
  assert.strictEqual(
    watch.evaluate({ promptTokens: 1000, cachedPromptTokens: 0, calls: 9 }),
    undefined,
  );
  assert.strictEqual(
    watch.evaluate({ promptTokens: 1000, cachedPromptTokens: 0, calls: 9, hitRate: Number.NaN }),
    undefined,
  );
});

test('坍塌判定：返回四个数字 + 生效阈值 + 事件名', () => {
  const watch = new CacheHitRateWatch(60);
  const breach = watch.evaluate({
    promptTokens: 10_000,
    cachedPromptTokens: 2_000,
    calls: 7,
    hitRate: 20,
  });
  assert.ok(breach !== undefined);
  assert.deepStrictEqual(breach, {
    hitRate: 20,
    promptTokens: 10_000,
    cachedPromptTokens: 2_000,
    calls: 7,
    threshold: 60,
    event: LOW_HIT_RATE_EVENT,
  });
});

test('落日志：坍塌时写出 warn 级结构化日志，字段含四个数字与阈值', () => {
  const watch = new CacheHitRateWatch(50);
  const { lines, result } = captureStderr(() =>
    watch.inspect({ promptTokens: 10_000, cachedPromptTokens: 1_000, calls: 6, hitRate: 10 }),
  );
  assert.ok(result !== undefined);
  const entries = parseLines(lines);
  const warn = entries.filter((entry) => entry['msg'] === LOW_HIT_RATE_EVENT);
  assert.strictEqual(warn.length, 1, '应恰好一条低命中率 warn');
  assert.strictEqual(warn[0]?.['level'], 'warn');
  assert.strictEqual(warn[0]?.['hitRate'], 10);
  assert.strictEqual(warn[0]?.['promptTokens'], 10_000);
  assert.strictEqual(warn[0]?.['cachedPromptTokens'], 1_000);
  assert.strictEqual(warn[0]?.['calls'], 6);
  assert.strictEqual(warn[0]?.['threshold'], 50);
});

test('不阻断：未坍塌时无日志，且 inspect 返回 undefined（调用方无分支可走）', () => {
  const watch = new CacheHitRateWatch(50);
  const { lines, result } = captureStderr(() =>
    watch.inspect({ promptTokens: 10_000, cachedPromptTokens: 9_000, calls: 6, hitRate: 90 }),
  );
  assert.strictEqual(result, undefined);
  assert.deepStrictEqual(parseLines(lines), []);
});

test('观测 fail-soft：stderr 写入抛错也不向调用方抛出异常', () => {
  const watch = new CacheHitRateWatch(50);
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => {
    throw new Error('stderr closed');
  }) as typeof process.stderr.write;
  try {
    const breach = watch.inspect({
      promptTokens: 1000,
      cachedPromptTokens: 0,
      calls: 5,
      hitRate: 0,
    });
    assert.ok(breach !== undefined, '判定结果仍然返回');
  } finally {
    process.stderr.write = original;
  }
});
