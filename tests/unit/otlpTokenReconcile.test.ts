/**
 * OTLP 线格式 ↔ 归因账目 的**对账判据**（Wave A.5 · OTel 导出评估的判据①）。
 *
 * ## 判据①在仓内到底该怎么判
 *
 * [ARCHITECTURE_TARGET_2026-10.md](../../docs/ARCHITECTURE_TARGET_2026-10.md) §5.3 判据①写的是
 * 「`scripts/observabilityReconcile.mjs` 对账一致」。但那条对账断言的是**归因恒等式**
 * （Σ 桶 == 汇总；缓存读是 prompt 的子集、不得相加），它吃的是**事件**，与导出器无关——
 * 换句话说：**换不换导出器，这条判据都不会变**，它是必要不充分条件。
 *
 * 真正被导出器影响、也真正会出事的是另一条：**发出去的 token 数必须就是账上认的 token 数**。
 * 线上表现为「账单/看板上的 token 与本地归因对不上」——这类事故不会触发归因恒等式，
 * 因为两边的数各自自洽。故本判据把两条链路接起来断言：
 *
 * ```
 * 同一批事件 ──┬─→ TokenAttribution.fromEvents(events)  → 汇总（账）
 *              └─→ TraceSpanBuilder → OtlpTraceExporter → PUT/POST 报文体（线）
 * ```
 *
 * 线格式里的 `gen_ai.usage.input_tokens` / `output_tokens` 必须**逐字段等于**账上的
 * `totalPromptTokens` / `totalCompletionTokens`；`tokens.total` 等于两者之和
 * （**缓存读不得计入**——它是 prompt 的子集，加进去就是把同一批 token 数两遍）。
 *
 * 变异自证：让导出器把缓存读加进输入 token ⇒ 本判据红；删掉 `tokens.total` ⇒ 红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokenAttribution } from '../../src/observability/tokenAttribution.js';
import { TraceSpanBuilder } from '../../src/observability/traceSpanBuilder.js';
import { OtlpTraceExporter } from '../../src/observability/otlpTraceExporter.js';
import type { Span } from '../../src/observability/otlpTraceExporter.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * 造一条事件。
 * @param type 事件类型
 * @param payload 载荷
 * @param ts 时间偏移（毫秒）
 * @returns 会话事件
 */
function eventOf(type: string, payload: Record<string, unknown>, ts: number): SessionEvent {
  return {
    id: `${type}-${String(ts)}`,
    type,
    sessionId: 's1',
    timestamp: new Date(1_700_000_000_000 + ts).toISOString(),
    payload,
  } as SessionEvent;
}

/**
 * 一批**带缓存读**的事件（缓存读是 prompt 的子集：prompt 100 里 40 命中缓存）。
 * @returns 事件数组
 */
function eventsWithCacheReads(): readonly SessionEvent[] {
  return [
    eventOf('session_meta', { workspace: '/tmp/ws' }, 0),
    eventOf('tool_call', { callId: 'c1', name: 'glob', args: {} }, 5),
    eventOf('tool_result', { callId: 'c1', ok: true, output: 'x' }, 8),
    eventOf(
      'model',
      {
        model: 'deepseek-chat',
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          cachedPromptTokens: 40,
          totalTokens: 120,
        },
      },
      10,
    ),
    eventOf('tool_call', { callId: 'c2', name: 'read', args: {} }, 15),
    eventOf('tool_result', { callId: 'c2', ok: false, output: '' }, 18),
    eventOf(
      'model',
      {
        model: 'deepseek-chat',
        usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0, totalTokens: 15 },
      },
      20,
    ),
  ];
}

/**
 * 取线格式报文体里的全部 span（名字 + 属性表）。
 *
 * **为什么必须跨 span 求和**：模型 span 上的 `usage` 是**按次**记账的（每次模型调用一个 span），
 * 而 `TokenAttribution` 的汇总数是**整场会话**的。第一版判据拿「第一个模型 span」去对「整份账目」，
 * 于是 100 !== 110 直接红——**错的是判据，不是实现**（写在这里免得下一个人重踩）。
 * @param events 事件数组
 * @returns span 列表（名字 + 属性表）
 */
async function wireSpansOf(
  events: readonly SessionEvent[],
): Promise<
  readonly { readonly name: string; readonly attrs: Map<string, Record<string, unknown>> }[]
> {
  let seq = 0;
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace-recon',
    spanIdFactory: () => `span-${String(++seq)}`,
  });
  for (const event of events) builder.consume(event);
  const captured: string[] = [];
  const exporter = new OtlpTraceExporter({
    endpoint: 'http://collector.test/v1/traces',
    serviceName: 'omniharness',
    fetchImpl: (async (_url: string, init?: { body?: unknown }) => {
      captured.push(String(init?.body ?? ''));
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  await exporter.export(builder.drain());
  await exporter.flush();
  const body = JSON.parse(captured[0] ?? '{}') as {
    resourceSpans?: readonly {
      scopeSpans?: readonly { spans?: readonly Span[] }[];
    }[];
  };
  const spans = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
  assert.ok(spans.length > 0, '报文体里必须有 span');
  return spans.map((span) => ({
    name: span.name,
    attrs: new Map(
      (span.attributes ?? []).map((a) => [a.key, a.value as unknown as Record<string, unknown>]),
    ),
  }));
}

/**
 * 从属性表里取 intValue 形态的整数（数值必须走 intValue：proto3 JSON 的 int64 是字符串）。
 * @param attrs 属性表
 * @param key 属性键
 * @returns 数值
 */
function intOf(attrs: Map<string, Record<string, unknown>>, key: string): number {
  const value = attrs.get(key);
  assert.ok(value !== undefined, `线格式缺少属性 ${key}`);
  assert.strictEqual(
    typeof value['intValue'],
    'string',
    `${key} 必须走 intValue（int64 的 proto3 JSON 形态），实际：${JSON.stringify(value)}`,
  );
  return Number(value['intValue']);
}

test('A.5-OTel 判据①（可判形式）：线上 token 数 == 归因账目数，且缓存读不计入', async () => {
  const events = eventsWithCacheReads();
  // 账：归因报告（既有恒等式仍须自洽，否则本判据的基准本身有问题）。
  const report = TokenAttribution.fromEvents(events);
  const bucketsTotal = report.buckets.reduce((acc, b) => acc + b.totalTokens, 0);
  assert.strictEqual(
    bucketsTotal,
    report.totalPromptTokens + report.totalCompletionTokens,
    '归因恒等式：Σ 桶.totalTokens == prompt + completion',
  );
  assert.strictEqual(report.totalPromptTokens, 110, 'prompt = 100 + 10（缓存读 40 是其中一部分）');
  assert.strictEqual(report.totalCompletionTokens, 25);
  assert.strictEqual(report.totalCachedPromptTokens, 40, '缓存读单列，不进 total');

  // 线：实际 POST 的报文体（模型 span 按次记账 ⇒ 必须跨 span 求和后才与账目可比）。
  const spans = await wireSpansOf(events);
  const modelSpans = spans.filter((s) => s.name.includes('chat') || s.name.includes('model'));
  assert.strictEqual(modelSpans.length, 2, '两次模型调用 ⇒ 两个模型 span（按次记账）');
  const wirePrompt = modelSpans.reduce(
    (acc, s) => acc + intOf(s.attrs, 'gen_ai.usage.input_tokens'),
    0,
  );
  const wireCompletion = modelSpans.reduce(
    (acc, s) => acc + intOf(s.attrs, 'gen_ai.usage.output_tokens'),
    0,
  );
  assert.strictEqual(
    wirePrompt,
    report.totalPromptTokens,
    '线上输入 token 之和必须等于账上 prompt 总数（含缓存读的总量，不得再加缓存读）',
  );
  assert.strictEqual(
    wireCompletion,
    report.totalCompletionTokens,
    '线上输出 token 之和必须等于账上 completion 总数',
  );

  // 缓存读不得把同一批 token 数两遍：单次 span 的 tokens.total == prompt + completion（不含 cached）。
  for (const span of modelSpans) {
    assert.strictEqual(
      intOf(span.attrs, 'tokens.total'),
      intOf(span.attrs, 'gen_ai.usage.input_tokens') +
        intOf(span.attrs, 'gen_ai.usage.output_tokens'),
      'tokens.total 必须等于 prompt + completion（缓存读是 prompt 的子集，不得相加）',
    );
    assert.strictEqual(
      intOf(span.attrs, 'tokens.prompt') - intOf(span.attrs, 'gen_ai.usage.input_tokens'),
      0,
      '过渡键 tokens.prompt 与新键 gen_ai.usage.input_tokens 必须同值（双写不得漂移）',
    );
  }

  // 汇总 span（若产出）上的会话级 token 必须与账目一致。
  const summary = spans.find((s) => s.attrs.has('session.tokens'));
  if (summary !== undefined) {
    assert.strictEqual(
      intOf(summary.attrs, 'session.tokens'),
      report.totalPromptTokens + report.totalCompletionTokens,
      '汇总 span 的 session.tokens 必须等于账目 prompt + completion',
    );
    assert.strictEqual(intOf(summary.attrs, 'session.model_calls'), report.modelCallsWithUsage);
  }
});
