/**
 * **自观测计数器**的判据（G24，2026-10-03 第十轮）。
 *
 * ## 背景（报告 §4 G24 / O3+O4）
 *
 * `OtlpTraceExporter.flush()` 的契约是"失败静默、绝不反噬业务"——这是对的，但它让**丢弃不可见**：
 * 端点打错、Collector 挂了、网络被拦，都会安静地丢 span，没人知道。本项把丢弃变成**数字**：
 * 只读快照、无样本给 0、不发警告、**不改任何业务分支**（照抄 `CacheHitRateCollector` 的范式）。
 *
 * 顺带关掉一条此前**完全没判**的静默丢弃路径：HTTP 响应明确失败（404/500）时旧实现当成发送成功
 * ——因为只看"有没有抛错"。现在计入 `spansDropped` 且原因可读（`http_500`）。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 注入**必失败** `fetchImpl` ⇒ `spansDropped`/`batchesDropped` 严格递增，且 `flush()` **不抛错** |
 * | ② | HTTP 明确失败（`ok:false`，如 500）⇒ 同样计入丢弃且 `lastDropReason='http_500'`（这条是新增覆盖） |
 * | ③ | 成功路径 ⇒ `spansSent`/`batchesSent` 递增，丢弃保持 0 |
 * | ④ | 从未尝试发送 ⇒ 全 0（把"没跑过"与"跑过且全丢"区分开） |
 * | ⑤ | 离线对账脚本：合法事件文件退出码 0、缺失文件退出码 1、无参数退出码 1 |
 * | ⑥ | 归因恒等式（**独立算路**交叉校验）：Σ桶 == 汇总字段，且 Σtotal == prompt + completion |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OtlpTraceExporter, type Span } from '../../src/observability/otlpTraceExporter.js';
import { TokenAttribution } from '../../src/observability/tokenAttribution.js';
import { spawnSyncAsync } from '../helpers/childProcess.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 仓库根（编译产物在 `dist/tests/unit/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 造一条 span。
 * @param i 序号。
 * @returns span。
 */
function spanOf(i: number): Span {
  return {
    traceId: 't1',
    spanId: `s${String(i)}`,
    name: 'agent.step',
    startTimeUnixNano: '1',
    endTimeUnixNano: '2',
  };
}

/**
 * 造一条模型事件（带 usage）。
 * @param prompt prompt token 数。
 * @param completion completion token 数。
 * @param cached 缓存命中的 prompt token 数（可省）。
 * @returns 会话事件。
 */
function modelEvent(prompt: number, completion: number, cached?: number): SessionEvent {
  return {
    id: `m${String(prompt)}_${String(completion)}`,
    type: 'model',
    sessionId: 's1',
    timestamp: new Date(0).toISOString(),
    payload: {
      usage: {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
      },
    },
  } as SessionEvent;
}

test('① 注入必失败 fetch ⇒ 丢弃计数严格递增，且 flush() 不抛错', async () => {
  const exporter = new OtlpTraceExporter({
    endpoint: 'http://collector:4318/v1/traces',
    maxBatch: 100,
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  const before = exporter.stats();
  assert.deepStrictEqual(
    {
      sent: before.batchesSent,
      dropped: before.batchesDropped,
      samples: before.spansSent + before.spansDropped,
    },
    { sent: 0, dropped: 0, samples: 0 },
    '④ 从未尝试发送时必须是全 0（把"没跑过"与"跑过且全丢"区分开）',
  );

  await exporter.export([spanOf(1), spanOf(2)]);
  await exporter.flush(); // 契约：不抛错
  const first = exporter.stats();
  assert.strictEqual(first.spansDropped, 2, '两个 span 全丢，必须如实计数');
  assert.strictEqual(first.batchesDropped, 1);
  assert.strictEqual(first.spansSent, 0);
  assert.strictEqual(first.lastDropReason, 'network');

  await exporter.export([spanOf(3)]);
  await exporter.flush();
  const second = exporter.stats();
  assert.ok(
    second.spansDropped > first.spansDropped,
    `丢弃计数必须严格递增（${String(first.spansDropped)} → ${String(second.spansDropped)}）`,
  );
  assert.strictEqual(second.spansDropped, 3);
});

test('② HTTP 明确失败（ok:false）也算丢弃，且原因可读（此前被当成发送成功）', async () => {
  const exporter = new OtlpTraceExporter({
    endpoint: 'http://collector:4318/v1/traces',
    maxBatch: 100,
    // 极简桩只需 `ok`/`status` 两个字段（真实 Response 之外的对象），故显式断言为 fetch 类型。
    fetchImpl: (() => Promise.resolve({ ok: false, status: 500 })) as unknown as typeof fetch,
  });
  await exporter.export([spanOf(1)]);
  await exporter.flush();
  const stats = exporter.stats();
  assert.strictEqual(
    stats.spansDropped,
    1,
    'HTTP 500 必须计入丢弃——旧实现只看"有没有抛错"，会当成成功',
  );
  assert.strictEqual(stats.spansSent, 0);
  assert.strictEqual(stats.lastDropReason, 'http_500');
  assert.strictEqual(stats.batchesSent, 0);
});

test('③ 成功路径：计数走 sent，丢弃保持 0；无 ok 字段的极简桩仍按成功计（兼容既有用法）', async () => {
  let posted = 0;
  const exporter = new OtlpTraceExporter({
    endpoint: 'http://collector:4318/v1/traces',
    maxBatch: 100,
    // 极简桩：只记次数、不返回 Response（既有测试就是这么写的）。
    fetchImpl: (() => {
      posted += 1;
      return Promise.resolve({});
    }) as unknown as typeof fetch,
  });
  await exporter.export([spanOf(1), spanOf(2), spanOf(3)]);
  await exporter.flush();
  const stats = exporter.stats();
  assert.strictEqual(posted, 1);
  assert.strictEqual(stats.spansSent, 3);
  assert.strictEqual(stats.batchesSent, 1);
  assert.strictEqual(stats.spansDropped, 0);
  assert.strictEqual(stats.lastDropReason, undefined, '从未丢弃时不得有原因（否则是假信号）');
});

test('⑥ 归因恒等式是独立算路的交叉校验：Σ桶 == 汇总字段，且 Σtotal == prompt + completion', () => {
  const events = [
    modelEvent(100, 20, 40),
    {
      id: 'c1',
      type: 'tool_call',
      sessionId: 's1',
      timestamp: new Date(1).toISOString(),
      payload: { callId: 'c1', name: 'glob', args: {} },
    } as SessionEvent,
    modelEvent(200, 30, 10),
    modelEvent(50, 5),
  ];
  const report = TokenAttribution.fromEvents(events);
  const sum = (pick: (b: (typeof report.buckets)[number]) => number): number =>
    report.buckets.reduce((acc, b) => acc + pick(b), 0);
  assert.strictEqual(
    sum((b) => b.totalTokens),
    report.totalPromptTokens + report.totalCompletionTokens,
    'Σ桶 total 必须等于 prompt + completion（缓存读是 prompt 的子集，不得重复计入）',
  );
  assert.strictEqual(
    sum((b) => b.promptTokens),
    report.totalPromptTokens,
  );
  assert.strictEqual(
    sum((b) => b.completionTokens),
    report.totalCompletionTokens,
  );
  assert.strictEqual(
    sum((b) => b.cachedPromptTokens),
    report.totalCachedPromptTokens,
  );
  assert.strictEqual(report.totalTokens, report.totalPromptTokens + report.totalCompletionTokens);
  // 缓存读**不**计入 total：否则 total 会大于 prompt+completion。
  assert.ok(
    report.totalCachedPromptTokens > 0 &&
      report.totalTokens <
        report.totalPromptTokens + report.totalCompletionTokens + report.totalCachedPromptTokens,
    '缓存读不得被加进 total（口径：它是 prompt 的子集）',
  );
});

test('⑤ 离线对账脚本：合法文件退出 0；缺失文件与无参数退出 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reconcile-'));
  try {
    const good = join(dir, 's1.jsonl');
    const lines = [modelEvent(10, 2, 4), modelEvent(20, 3)].map((e) => JSON.stringify(e));
    writeFileSync(good, `${lines.join('\n')}\n`, 'utf8');

    const script = join(REPO_ROOT, 'scripts/observabilityReconcile.mjs');
    const okRun = await spawnSyncAsync('node', [script, good], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(
      okRun.status,
      0,
      `合法文件应退出 0，实际 ${String(okRun.status)}：${String(okRun.stdout)}`,
    );

    const missing = await spawnSyncAsync('node', [script, join(dir, 'nope.jsonl')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(missing.status, 1, '缺失文件必须退出 1（可诊断的失败，而不是崩溃）');

    const noArgs = await spawnSyncAsync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.strictEqual(noArgs.status, 1, '无参数必须退出 1 并打印用法');
    assert.match(String(noArgs.stdout), /用法/, '无参数时要给出用法，不能静默失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤b 对账脚本对"无 usage 的模型调用"单列，避免把归因缺口读成全量覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reconcile-'));
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 's2.jsonl');
    // 一条有 usage、一条没有（usage 缺失的调用**不进任何桶**，必须被单列出来）。
    const withoutUsage = {
      id: 'm-no-usage',
      type: 'model',
      sessionId: 's1',
      timestamp: new Date(3).toISOString(),
      payload: { content: 'x' },
    };
    writeFileSync(
      file,
      `${[modelEvent(7, 1), withoutUsage].map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
    const script = join(REPO_ROOT, 'scripts/observabilityReconcile.mjs');
    const run = await spawnSyncAsync('node', [script, file], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.strictEqual(run.status, 0);
    assert.match(
      String(run.stdout),
      /无 usage 1 次/,
      `必须单列没有 usage 的调用，实际输出：${String(run.stdout)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
