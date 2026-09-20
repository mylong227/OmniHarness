/**
 * 上下文容量服务的**缓存命中统计**语义测试（缺口 B：让命中率不是摆设）。
 *
 * 六个断言簇，逐条对应「这个数字会被用错」的具体方式：
 *  1. 三态来源（measured / estimated / empty）不被混淆；
 *  2. `promptTokens = 0` 不产生 NaN / Infinity；
 *  3. `cached > prompt`（端点脏值）被钳制，命中率恒 ≤100%；
 *  4. 非数字 / 缺字段的 payload 被**整条忽略**（绝不当作「0 命中」计入平均）；
 *  5. 多事件聚合是**按 token 加权**，不是按条数算术平均；
 *  6. `hitRate` 的舍入口径是 `Math.round(x*1000)/10`（一位小数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ContextUsageService } from '../../src/server/services/contextUsageService.js';
import type { ContextUsageReport } from '../../src/server/services/contextUsageService.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ToolDefinition } from '../../src/ports/tool/tool.js';

/** 构造一条会话事件（只填容量服务会读的字段）。 */
function event(type: SessionEvent['type'], payload: unknown): SessionEvent {
  return { id: `e-${type}`, type, sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', payload };
}

/** 构造一条带 usage 的 model 事件。 */
function modelEvent(usage: unknown): SessionEvent {
  return event('model', { usage });
}

/** 合法的上下文快照（走 measured 路径）。 */
const SNAPSHOT = {
  windowTokens: 128_000,
  usedTokens: 1_000,
  mcpToolCount: 0,
  systemToolCount: 0,
  tokens: { messages: 1_000 },
};

/**
 * 构造被测服务。
 * @param events 回放返回的事件序列。
 * @param withSnapshot 是否让最近一条 model 事件携带合法快照（决定 measured / estimated）。
 * @returns 容量服务实例。
 */
function service(events: readonly SessionEvent[], withSnapshot: boolean): ContextUsageService {
  const replayEvents: SessionEvent[] = withSnapshot
    ? [...events, event('model', { usage: { promptTokens: 1 }, context: SNAPSHOT })]
    : [...events];
  return new ContextUsageService({
    replay: async () => replayEvents,
    tools: (): readonly ToolDefinition[] => [],
    baseFragments: () => [],
    model: () => 'deepseek-chat',
  });
}

/**
 * 跑一次 usage 并断言拿到报告。
 * @param svc 容量服务。
 * @returns 报告。
 */
async function reportOf(svc: ContextUsageService): Promise<ContextUsageReport> {
  return svc.usage('s1');
}

test('三态来源：有快照 ⇒ measured；无快照有事件 ⇒ estimated；无事件 ⇒ empty', async () => {
  const withSnapshot = await reportOf(service([event('user', { content: 'hi' })], true));
  assert.strictEqual(withSnapshot.source, 'measured');

  const withoutSnapshot = await reportOf(service([event('user', { content: 'hi' })], false));
  assert.strictEqual(withoutSnapshot.source, 'estimated');

  const noEvents = await reportOf(service([], false));
  assert.strictEqual(noEvents.source, 'empty');
});

test('三态来源：来源标注不影响缓存统计（cache 独立于 source 计算）', async () => {
  const events = [modelEvent({ promptTokens: 100, cachedPromptTokens: 40 })];
  const measured = await reportOf(service(events, true));
  const estimated = await reportOf(service(events, false));
  assert.strictEqual(measured.source, 'measured');
  assert.strictEqual(estimated.source, 'estimated');
  assert.deepStrictEqual(measured.cache, estimated.cache);
  assert.strictEqual(measured.cache.hitRate, 40);
  assert.strictEqual(measured.cache.calls, 1);
});

test('promptTokens=0：不产生 NaN / Infinity，hitRate 记 0', async () => {
  const report = await reportOf(
    service([modelEvent({ promptTokens: 0, cachedPromptTokens: 0 })], true),
  );
  assert.strictEqual(report.cache.promptTokens, 0);
  assert.strictEqual(report.cache.cachedPromptTokens, 0);
  assert.strictEqual(report.cache.calls, 1);
  assert.strictEqual(report.cache.hitRate, 0);
  assert.strictEqual(Number.isFinite(report.cache.hitRate ?? NaN), true);
});

test('cached > prompt（端点脏值）：钳制到 promptTokens，命中率不超过 100%', async () => {
  const report = await reportOf(
    service([modelEvent({ promptTokens: 100, cachedPromptTokens: 500 })], true),
  );
  assert.strictEqual(report.cache.cachedPromptTokens, 100);
  assert.strictEqual(report.cache.hitRate, 100);
  assert.ok((report.cache.hitRate ?? 101) <= 100);
});

test('非数字 / 缺字段的 payload 被整条忽略（不得当作 0 命中计入平均）', async () => {
  const report = await reportOf(
    service(
      [
        modelEvent({ promptTokens: 1000, cachedPromptTokens: 500 }), // 有效：50%
        modelEvent({ promptTokens: 1000 }), // 缺 cached 字段 ⇒ 排除
        modelEvent({ promptTokens: 1000, cachedPromptTokens: 'many' }), // 非数字 ⇒ 排除
        modelEvent({ promptTokens: 1000, cachedPromptTokens: Number.NaN }), // NaN ⇒ 排除
        modelEvent({ promptTokens: 1000, cachedPromptTokens: -5 }), // 负数 ⇒ 排除
        modelEvent({ promptTokens: Number.POSITIVE_INFINITY, cachedPromptTokens: 1 }), // 分母脏 ⇒ 排除
        modelEvent({ cachedPromptTokens: 900 }), // 缺分母 ⇒ 排除
        modelEvent(undefined), // 无 usage ⇒ 排除
        event('assistant', { usage: 'not-an-object' }), // 非 model 事件 ⇒ 不参与
      ],
      true,
    ),
  );
  assert.strictEqual(report.cache.calls, 1, '只有一条 payload 合法');
  assert.strictEqual(report.cache.promptTokens, 1000);
  assert.strictEqual(report.cache.cachedPromptTokens, 500);
  assert.strictEqual(report.cache.hitRate, 50);
});

test('聚合口径：按 token 加权（Σcached/Σprompt），不是按调用条数的算术平均', async () => {
  // 两次调用：[prompt 10, cached 0] 与 [prompt 100000, cached 90000]。
  // 按 token 加权 = 90000/100010 = 89.99% ≈ 90.0；按条数平均 = (0% + 90%)/2 = 45%。
  const report = await reportOf(
    service(
      [
        modelEvent({ promptTokens: 10, cachedPromptTokens: 0 }),
        modelEvent({ promptTokens: 100_000, cachedPromptTokens: 90_000 }),
      ],
      true,
    ),
  );
  assert.strictEqual(report.cache.calls, 2);
  assert.strictEqual(report.cache.promptTokens, 100_010);
  assert.strictEqual(report.cache.cachedPromptTokens, 90_000);
  assert.strictEqual(report.cache.hitRate, 90);
  assert.notStrictEqual(report.cache.hitRate, 45, '不得退化为按条数算术平均');
});

test('舍入口径：Math.round(ratio*1000)/10 ⇒ 一位小数', async () => {
  // 1/3 = 33.333…% ⇒ 33.3；2/3 = 66.666…% ⇒ 66.7；1/8 = 12.5% ⇒ 12.5。
  const cases: readonly {
    readonly prompt: number;
    readonly cached: number;
    readonly want: number;
  }[] = [
    { prompt: 3, cached: 1, want: 33.3 },
    { prompt: 3, cached: 2, want: 66.7 },
    { prompt: 8, cached: 1, want: 12.5 },
    { prompt: 200, cached: 1, want: 0.5 },
  ];
  for (const item of cases) {
    const report = await reportOf(
      service([modelEvent({ promptTokens: item.prompt, cachedPromptTokens: item.cached })], true),
    );
    assert.strictEqual(report.cache.hitRate, item.want, `${item.cached}/${item.prompt}`);
  }
});

test('无任何上报缓存的调用：calls=0 且 hitRate 缺省（UI 显示「—」而不是 0%）', async () => {
  const report = await reportOf(
    service([modelEvent({ promptTokens: 100, completionTokens: 1, totalTokens: 101 })], true),
  );
  assert.deepStrictEqual(report.cache, { promptTokens: 0, cachedPromptTokens: 0, calls: 0 });
  assert.strictEqual(report.cache.hitRate, undefined);
});

test('回放抛错：降级为 empty 报告且缓存统计全零（绝不抛错打断会话）', async () => {
  const svc = new ContextUsageService({
    replay: async () => {
      throw new Error('archive unreadable');
    },
    tools: () => [],
    baseFragments: () => [],
    model: () => 'deepseek-chat',
  });
  const report = await svc.usage('s1');
  assert.strictEqual(report.source, 'empty');
  assert.deepStrictEqual(report.cache, { promptTokens: 0, cachedPromptTokens: 0, calls: 0 });
});

test('空会话 id：直接返回 empty 报告，不触发回放', async () => {
  let replayed = 0;
  const svc = new ContextUsageService({
    replay: async () => {
      replayed += 1;
      return [];
    },
    tools: () => [],
    baseFragments: () => [],
    model: () => 'deepseek-chat',
  });
  const report = await svc.usage('');
  assert.strictEqual(report.source, 'empty');
  assert.strictEqual(replayed, 0);
});

test('可执行化：≥5 次调用且命中率低于阈值 ⇒ usage() 真的写出 warn 结构化日志', async () => {
  const events = Array.from({ length: 6 }, () =>
    modelEvent({ promptTokens: 1000, cachedPromptTokens: 100 }),
  );
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  let report: ContextUsageReport;
  try {
    report = await reportOf(service(events, true));
  } finally {
    process.stderr.write = original;
  }
  assert.strictEqual(report.cache.calls, 6);
  assert.strictEqual(report.cache.hitRate, 10);
  const warn = lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['msg'] === 'model.cache.lowHitRate');
  assert.strictEqual(warn.length, 1, '应恰好一条 model.cache.lowHitRate 告警');
  assert.strictEqual(warn[0]?.['level'], 'warn');
  assert.strictEqual(warn[0]?.['hitRate'], 10);
  assert.strictEqual(warn[0]?.['promptTokens'], 6000);
  assert.strictEqual(warn[0]?.['cachedPromptTokens'], 600);
  assert.strictEqual(warn[0]?.['calls'], 6);
});

test('可执行化：调用数不足 5 次时不告警（小样本静默），但统计照常返回', async () => {
  const events = Array.from({ length: 4 }, () =>
    modelEvent({ promptTokens: 1000, cachedPromptTokens: 0 }),
  );
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  let report: ContextUsageReport;
  try {
    report = await reportOf(service(events, true));
  } finally {
    process.stderr.write = original;
  }
  assert.strictEqual(report.cache.calls, 4);
  assert.strictEqual(report.cache.hitRate, 0);
  assert.deepStrictEqual(
    lines.filter((line) => line.includes('model.cache.lowHitRate')),
    [],
  );
});
