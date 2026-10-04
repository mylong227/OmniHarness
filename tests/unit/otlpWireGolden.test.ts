/**
 * OTLP **线格式 golden 判据**（Wave A.5 · OTel 导出评估的前置：先让判据②可判）。
 *
 * ## 为什么需要它
 *
 * [ARCHITECTURE_TARGET_2026-10.md](../../docs/ARCHITECTURE_TARGET_2026-10.md) §5.3 把 OTel 候选列为
 * **B 级（先测后买）**，判据②是「**既有 golden 哈希不变**（过渡键并行策略保留）」。
 * 但评估开始时仓内**并没有**这道判据——只有「POST 发生过 / 失败被丢弃」这类行为断言，
 * 线格式改一位、过渡键被删一个，都不会有人发现。**先有判据，才谈得上评估**，故本文件先补上：
 *
 * 1. **线格式 golden 哈希**：固定事件 → `TraceSpanBuilder` → `OtlpTraceExporter` 实际 POST 的报文体
 *    逐字节 sha256 固定。线格式是**对外契约**（Collector/后端的解析面），改它必须是一次显式决定；
 * 2. **过渡键并行**：模型 span 上必须**同时**出现新键与旧键（`semconv` 迁移期的双写策略）。
 *    键名按**字面量**断言，而不是从 `LEGACY_KEYS` 枚举——后者会让「改常量 + 改实现」恒绿（§11.3 的铁律）；
 * 3. **数值走 `intValue`**：token 计数在 proto3 JSON 里必须是 `intValue`（字符串形态的 int64），
 *    塞 `stringValue` 会让标准 GenAI 后端按类型分派失败。
 *
 * 变异自证：删掉任一 legacy 键、把 token 改成 `stringValue`、或改动报文体结构 ⇒ 三条判据分别变红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { TraceSpanBuilder } from '../../src/observability/traceSpanBuilder.js';
import { OtlpTraceExporter } from '../../src/observability/otlpTraceExporter.js';
import type { Span } from '../../src/observability/otlpTraceExporter.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * golden 哈希（线格式契约的指纹）。
 *
 * **怎么来的**：固定夹具（注入 trace/span id 工厂 + 固定事件时间戳）经导出器 POST 的报文体
 * `JSON.stringify(body)` 的 sha256。**改动即红是有意的**——线格式变了就必须来改这一行，
 * 并在提交信息里说明为什么值得改（这就是「显式决定」的落地形式）。
 */
const GOLDEN_SHA256 = '8d37ea36a8bca7dbf1125f25491e81e7241a0d67c5a56eb3f4302112079bf080';

/** 模型 span 上必须**同时**出现的新键（字面量，不走常量枚举）。 */
const EXPECTED_NEW_KEYS: readonly string[] = [
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
];

/** 模型 span 上必须**同时**出现的旧键（过渡期双写；删任一个即红）。 */
const EXPECTED_LEGACY_KEYS_ON_MODEL: readonly string[] = [
  'session.id',
  'model.name',
  'tokens.prompt',
  'tokens.completion',
  'tokens.total',
];

/**
 * 造一条事件。
 * @param type 事件类型
 * @param payload 载荷
 * @param ts 事件时间偏移（毫秒）
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
 * 走一遍真实链路（构造器 → 导出器），返回实际 POST 的报文体文本。
 * @returns 报文体字符串与解析后的对象
 */
async function captureWirePayload(): Promise<{
  readonly text: string;
  readonly body: {
    readonly resourceSpans: readonly {
      readonly resource: { readonly attributes: readonly { key: string; value: unknown }[] };
      readonly scopeSpans: readonly {
        readonly scope: { readonly name: string };
        readonly spans: readonly Span[];
      }[];
    }[];
  };
}> {
  let seq = 0;
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace-fixed',
    spanIdFactory: () => `span-${String(++seq)}`,
  });
  builder.consume(eventOf('session_meta', { workspace: '/tmp/ws' }, 0));
  builder.consume(eventOf('tool_call', { callId: 'c1', name: 'glob', args: {} }, 10));
  builder.consume(eventOf('tool_result', { callId: 'c1', ok: true, output: 'x' }, 20));
  builder.consume(
    eventOf(
      'model',
      {
        model: 'deepseek-chat',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      30,
    ),
  );

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
  assert.strictEqual(captured.length, 1, '必须恰好发出 1 个批次');
  const text = captured[0] ?? '';
  return { text, body: JSON.parse(text) as Awaited<ReturnType<typeof captureWirePayload>>['body'] };
}

test('A.5-OTel 线格式 golden：报文体逐字节哈希固定（改线格式必须显式来改这一行）', async () => {
  const { text } = await captureWirePayload();
  const actual = createHash('sha256').update(text, 'utf8').digest('hex');
  assert.strictEqual(
    actual,
    GOLDEN_SHA256,
    `OTLP 报文体哈希变了。若这是有意改动，请更新 GOLDEN_SHA256 并在提交信息说明理由。\n实际：${actual}`,
  );
});

test('A.5-OTel 过渡键并行：模型 span 上新旧键并存（按字面量断言，删任一个即红）', async () => {
  const { body } = await captureWirePayload();
  const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  const modelSpan = spans.find((s) => s.name.includes('chat') || s.name.includes('model'));
  assert.ok(
    modelSpan !== undefined,
    `未找到模型 span（实际：${spans.map((s) => s.name).join(', ')}）`,
  );
  const keys = new Set((modelSpan.attributes ?? []).map((a) => a.key));
  for (const key of EXPECTED_NEW_KEYS) {
    assert.ok(keys.has(key), `缺少新键 ${key}（semconv 侧）`);
  }
  for (const key of EXPECTED_LEGACY_KEYS_ON_MODEL) {
    assert.ok(keys.has(key), `缺少过渡键 ${key}——「过渡键并行策略保留」被破坏`);
  }
});

test('A.5-OTel 数值形态：token 计数必须是 intValue（int64 的 proto3 JSON 形态是字符串）', async () => {
  const { body } = await captureWirePayload();
  const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  const modelSpan = spans.find((s) => s.name.includes('chat') || s.name.includes('model'));
  assert.ok(modelSpan !== undefined);
  const attrs = new Map((modelSpan.attributes ?? []).map((a) => [a.key, a.value]));
  for (const key of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'tokens.total']) {
    const value = attrs.get(key) as Record<string, unknown> | undefined;
    assert.ok(value !== undefined, `缺少属性 ${key}`);
    assert.ok(
      typeof value['intValue'] === 'string',
      `${key} 必须走 intValue（字符串形态的 int64），实际：${JSON.stringify(value)}`,
    );
    assert.strictEqual(value['stringValue'], undefined, `${key} 不得同时塞 stringValue`);
  }
  // 输入 token 是「含缓存读的总量」：本夹具 promptTokens=100 ⇒ intValue 必须是 '100'（不得加上缓存读）。
  assert.strictEqual(
    (attrs.get('gen_ai.usage.input_tokens') as Record<string, unknown>)['intValue'],
    '100',
  );
});
