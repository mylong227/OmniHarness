/**
 * 上下文容量服务的**缓存命中统计 + 未命中分因**语义测试（缺口 B：让命中率不是摆设）。
 *
 * 断言簇，逐条对应「这个数字会被用错」的具体方式：
 *  1. 三态来源（measured / estimated / empty）不被混淆；
 *  2. `promptTokens = 0` 不产生 NaN / Infinity；
 *  3. `cached > prompt`（端点脏值）被钳制，命中率恒 ≤100%；
 *  4. 非数字 / 缺字段的 payload 被**整条忽略**（绝不当作「0 命中」计入平均）；
 *  5. 多事件聚合是**按 token 加权**，不是按条数算术平均；
 *  6. `hitRate` 的舍入口径是 `Math.round(x*1000)/10`（一位小数）；
 *  7. **最近一次调用的分因**（2026-10-15）：`lastCall` 的 token 与信号取自**同一条**事件，
 *     且"没读数 / 冷启动 / 前缀被改写 / TTL 过期 / 原因不明"必须能被分别触发。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { ContextUsageService } from '../../src/server/services/contextUsageService.ts';
import type { ContextUsageReport } from '../../src/server/services/contextUsageService.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';
import type { ToolDefinition } from '../../src/ports/tool/tool.ts';

/**
 * 构造一条会话事件（只填容量服务会读的字段）。
 * @param type 事件类型。
 * @param payload 事件载荷。
 * @param timestamp ISO 时间戳（间隔信号取自它）。
 * @returns 会话事件。
 */
function event(
  type: SessionEvent['type'],
  payload: unknown,
  timestamp = '2026-01-01T00:00:00.000Z',
): SessionEvent {
  return { id: `e-${type}`, type, sessionId: 's1', timestamp, payload };
}

/**
 * 构造一条带 usage 的 model 事件。
 * @param usage 该次调用的用量（缺 `cachedPromptTokens` = 端点没上报 ⇒ 不进统计）。
 * @param extra 可选的上下文快照（前缀复用率信号）与事件时间戳（间隔信号）。
 * @returns 会话事件。
 */
function modelEvent(
  usage: unknown,
  extra: { readonly context?: unknown; readonly timestamp?: string } = {},
): SessionEvent {
  const payload = extra.context === undefined ? { usage } : { usage, context: extra.context };
  return event('model', payload, extra.timestamp);
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
    events: async () => replayEvents,
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

test('无任何上报缓存的调用：calls=0 且 hitRate 缺省（UI 显示「—」而不是 0%），分因是 not-reported', async () => {
  const report = await reportOf(
    service([modelEvent({ promptTokens: 100, completionTokens: 1, totalTokens: 101 })], true),
  );
  assert.strictEqual(report.cache.promptTokens, 0);
  assert.strictEqual(report.cache.cachedPromptTokens, 0);
  assert.strictEqual(report.cache.calls, 0);
  assert.strictEqual(report.cache.hitRate, undefined);
  // 分因与聚合字段**并存**：没有读数时也要能说清"不是 0 命中，而是没有读数"。
  assert.strictEqual(report.cache.lastCall.cause, 'not-reported');
  assert.strictEqual(report.cache.lastCall.promptTokens, 0);
  assert.match(
    report.cache.lastCall.reason,
    /0 次/u,
    '理由必须点明"本会话 0 次上报"，而不是含糊的"没数据"',
  );
});

test('回放抛错：降级为 empty 报告且缓存统计全零（绝不抛错打断会话），分因仍可用', async () => {
  const svc = new ContextUsageService({
    events: async () => {
      throw new Error('archive unreadable');
    },
    tools: () => [],
    baseFragments: () => [],
    model: () => 'deepseek-chat',
  });
  const report = await svc.usage('s1');
  assert.strictEqual(report.source, 'empty');
  assert.strictEqual(report.cache.promptTokens, 0);
  assert.strictEqual(report.cache.cachedPromptTokens, 0);
  assert.strictEqual(report.cache.calls, 0);
  assert.strictEqual(report.cache.hitRate, undefined);
  assert.strictEqual(report.cache.lastCall.cause, 'not-reported');
});

test('空会话 id：直接返回 empty 报告，不触发回放', async () => {
  let replayed = 0;
  const svc = new ContextUsageService({
    events: async () => {
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

// ---------------------------------------------------------------------------
// 最近一次调用的**未命中分因**（2026-10-15；销掉看板 §8.11 登记的那条遗留）
// ---------------------------------------------------------------------------

test('分因① 冷启动：仅一次调用且 0 命中 ⇒ cold-start（不是"缓存坏了"）', async () => {
  const report = await reportOf(
    service([modelEvent({ promptTokens: 1000, cachedPromptTokens: 0 })], false),
  );
  assert.strictEqual(report.cache.lastCall.cause, 'cold-start');
  assert.strictEqual(report.cache.lastCall.promptTokens, 1000);
  assert.strictEqual(report.cache.lastCall.cachedPromptTokens, 0);
});

test('分因② 前缀被改写：最近一次 0 命中 + 它自己的快照前缀比 < 0.9 ⇒ prefix-rewrite', async () => {
  const report = await reportOf(
    service(
      [
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 900 },
          { context: { ...SNAPSHOT, prefixReuseRatio: 0.99 } },
        ),
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          { context: { ...SNAPSHOT, prefixReuseRatio: 0.5 } },
        ),
      ],
      false,
    ),
  );
  assert.strictEqual(report.cache.calls, 2);
  assert.strictEqual(report.cache.hitRate, 45, '聚合口径不受分因影响');
  assert.strictEqual(report.cache.lastCall.cause, 'prefix-rewrite');
  assert.match(report.cache.lastCall.reason, /0\.500/u, '理由必须带实际比值，便于当场核对');
  assert.strictEqual(report.cache.lastCall.evidence['prefixReuseRatio'], 0.5);
});

test('分因③ TTL 过期：前缀稳定但上次请求在 TTL 之前 ⇒ ttl-expired（外部条件）', async () => {
  const snapshot = { ...SNAPSHOT, prefixReuseRatio: 0.99 };
  const report = await reportOf(
    service(
      [
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          { context: snapshot, timestamp: '2026-01-01T00:00:00.000Z' },
        ),
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          { context: snapshot, timestamp: '2026-01-01T00:10:00.000Z' },
        ),
      ],
      false,
    ),
  );
  assert.strictEqual(report.cache.lastCall.cause, 'ttl-expired');
  assert.match(report.cache.lastCall.reason, /600000ms/u, '理由必须给实际间隔');
});

test('分因④ 边界：间隔恰好等于 TTL 不算过期；两个信号都在 ⇒ 才敢说"前缀稳定"', async () => {
  const snapshot = { ...SNAPSHOT, prefixReuseRatio: 0.99 };
  const report = await reportOf(
    service(
      [
        modelEvent(
          { promptTokens: 10, cachedPromptTokens: 0 },
          { context: snapshot, timestamp: '2026-01-01T00:00:00.000Z' },
        ),
        modelEvent(
          { promptTokens: 10, cachedPromptTokens: 0 },
          { context: snapshot, timestamp: '2026-01-01T00:05:00.000Z' },
        ),
      ],
      false,
    ),
  );
  assert.strictEqual(report.cache.lastCall.cause, 'unknown');
  assert.match(report.cache.lastCall.reason, /前缀稳定/u);
});

test('分因⑤ 旧会话没有前缀信号：不得冒充"前缀稳定"（没测到 ≠ 没问题）', async () => {
  const report = await reportOf(
    service(
      [
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          { context: SNAPSHOT, timestamp: '2026-01-01T00:00:00.000Z' },
        ),
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          { context: SNAPSHOT, timestamp: '2026-01-01T00:00:01.000Z' },
        ),
      ],
      false,
    ),
  );
  assert.strictEqual(report.cache.lastCall.cause, 'unknown');
  assert.match(report.cache.lastCall.reason, /缺前缀占比/u);
  assert.doesNotMatch(report.cache.lastCall.reason, /前缀稳定/u);
});

test('分因⑥ 信号取"最近一次上报调用"那条事件，不得借尾随调用的低比值', async () => {
  const report = await reportOf(
    service(
      [
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          {
            context: { ...SNAPSHOT, prefixReuseRatio: 0.2 },
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ),
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          {
            context: { ...SNAPSHOT, prefixReuseRatio: 0.99 },
            timestamp: '2026-01-01T00:00:01.000Z',
          },
        ),
        // 尾随一条**没上报**缓存的调用（辅助调用形态），它的比值很低——不得被借来当证据。
        event('model', { context: { ...SNAPSHOT, prefixReuseRatio: 0.1 } }),
      ],
      false,
    ),
  );
  assert.strictEqual(report.cache.calls, 2, '没上报的调用不进统计');
  assert.strictEqual(report.cache.lastCall.cause, 'unknown');
  assert.strictEqual(report.cache.lastCall.evidence['prefixReuseRatio'], 0.99);
});

test('分因⑦ 命中：最近一次有命中 ⇒ hit，理由带命中量（不冒充未命中）', async () => {
  const report = await reportOf(
    service([modelEvent({ promptTokens: 1000, cachedPromptTokens: 250 })], true),
  );
  assert.strictEqual(report.cache.lastCall.cause, 'hit');
  assert.match(report.cache.lastCall.reason, /250\/1000/u);
});

test('分因结果可直接进 RPC：字段集合稳定，缺省信号不得被 JSON 静默丢掉', async () => {
  const report = await reportOf(
    service(
      [
        modelEvent(
          { promptTokens: 1000, cachedPromptTokens: 0 },
          { context: { ...SNAPSHOT, prefixReuseRatio: 0.5 } },
        ),
      ],
      false,
    ),
  );
  const serialized = JSON.stringify(report.cache);
  for (const key of ['lastCall', 'cause', 'reason', 'evidence', 'prefixReuseRatio']) {
    assert.ok(serialized.includes(`"${key}"`), `RPC 序列化里必须含 ${key}（undefined 会被丢掉）`);
  }
});

test('回归：上报了但命中率低时，日志分因不得报「端点未上报」（面板与日志同源）', async () => {
  // 6 次调用、每次都上报 0 命中，最近一次前缀比 0.5 ⇒ 结论应是 prefix-rewrite。
  // 修前：观测器读 `cachedPromptTokensReported`，而服务端从未设置它 ⇒ 一律报 not-reported，
  // 与"确实上报了、只是没命中"这一事实相反（这正是 §8.11 声称落地、实际没接上的那一处）。
  const events = Array.from({ length: 6 }, (_unused, i) =>
    modelEvent(
      { promptTokens: 1000, cachedPromptTokens: 0 },
      {
        context: { ...SNAPSHOT, prefixReuseRatio: 0.5 },
        timestamp: `2026-01-01T00:00:0${String(i)}.000Z`,
      },
    ),
  );
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  let report: ContextUsageReport;
  try {
    report = await reportOf(service(events, false));
  } finally {
    process.stderr.write = original;
  }
  assert.strictEqual(report.cache.hitRate, 0);
  const warn = lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['msg'] === 'model.cache.lowHitRate');
  assert.strictEqual(warn.length, 1);
  assert.strictEqual(warn[0]?.['cause'], 'prefix-rewrite', '日志分因必须与面板一致');
  assert.notStrictEqual(warn[0]?.['cause'], 'not-reported', '上报了就不是"没读数"');
});
