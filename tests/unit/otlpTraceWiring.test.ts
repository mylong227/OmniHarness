/**
 * OTLP 接线单测：span 构造（tool/model/session）+ 事件端口装饰器 + 环境装配。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`otlpTraceExporter.ts` 有实现、有单测，但
 * **没有任何生产接线点**（全仓只有它自己的测试引用它）⇒ 属「写了但没接线」。
 * 本文件把接线后的行为钉住：事件流真能产出 span、真能导出、未配端点时零行为变更。
 *
 * 注：文件名原为 `traceWiring.test.ts`；为了让位给 T4.5 只读自省 trace 的接线单测
 * （同名主题、不同子系统），2026-09-19 更名为 `otlpTraceWiring.test.ts`，内容逐字未改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { Span, TraceExporterPort } from '../../src/observability/otlpTraceExporter.js';
import { TraceSpanBuilder } from '../../src/observability/traceSpanBuilder.js';
import { TraceCollectingEventPort } from '../../src/observability/traceCollectingEventPort.js';
import { TraceExporterAssembly } from '../../src/observability/traceExporterAssembly.js';

/** 造事件（只填本测试关心的字段）。 */
const ev = (
  type: SessionEvent['type'],
  payload: unknown,
  at = '2026-09-19T10:00:00.000Z',
): SessionEvent => ({
  id: `e-${type}-${String(Math.random()).slice(2, 8)}`,
  type,
  sessionId: 's1',
  timestamp: at,
  payload,
});

/** 记录型事件端口（验证透传）。 */
class RecordingPort implements EventPort {
  /** 端口标识。 */
  public readonly name = 'recording';
  /** 收到的事件（按序）。 */
  public readonly seen: SessionEvent[] = [];
  /**
   * 记录一条事件。
   *
   * @param event 会话事件。
   * @returns 无返回值。
   */
  public emit(event: SessionEvent): void {
    this.seen.push(event);
  }
}

/** 记录型导出器（验证 export/flush 真被调用）。 */
class RecordingExporter implements TraceExporterPort {
  /** 端口标识。 */
  public readonly name = 'recording-export';
  /** 已导出的 span（累积）。 */
  public exported: Span[] = [];
  /** flush 被调用次数。 */
  public flushes = 0;
  /**
   * 记录一批 span。
   *
   * @param spans 待导出 span。
   * @returns 无返回值（本假实现无 IO）。
   */
  public async export(spans: readonly Span[]): Promise<void> {
    this.exported = [...this.exported, ...spans];
  }
  /**
   * 记录一次冲刷。
   *
   * @returns 无返回值。
   */
  public async flush(): Promise<void> {
    this.flushes += 1;
  }
}

/** 确定性 id 生成器。 */
const ids = (): (() => string) => {
  let n = 0;
  return () => {
    n += 1;
    return `id${String(n).padStart(4, '0')}`;
  };
};

test('TraceSpanBuilder：tool_call/tool_result 配对产出 tool.<name> span（含成败属性）', () => {
  const builder = new TraceSpanBuilder({ traceIdFactory: () => 'trace', spanIdFactory: ids() });
  builder.consume(
    ev('tool_call', { callId: 'c1', name: 'shell', args: {} }, '2026-09-19T10:00:00.000Z'),
  );
  builder.consume(ev('tool_result', { callId: 'c1', ok: false }, '2026-09-19T10:00:01.000Z'));
  const spans = builder.drain();
  const toolSpans = spans.filter((s) => s.name.startsWith('tool.'));

  assert.strictEqual(toolSpans.length, 1, `应恰好一条 tool span，实际 ${String(toolSpans.length)}`);
  assert.strictEqual(toolSpans[0]!.name, 'tool.shell');
  assert.strictEqual(toolSpans[0]!.traceId, 'trace');
  assert.strictEqual(toolSpans[0]!.startTimeUnixNano, '1789812000000000000');
  assert.strictEqual(toolSpans[0]!.endTimeUnixNano, '1789812001000000000');
  const attrs = new Map((toolSpans[0]!.attributes ?? []).map((a) => [a.key, a.value.stringValue]));
  assert.strictEqual(attrs.get('tool.ok'), 'false');
  assert.strictEqual(attrs.get('session.id'), 's1');
  assert.ok(
    spans.some((s) => s.name === 'session'),
    'drain 应同时给出会话汇总 span（同一批次）',
  );
});

test('TraceSpanBuilder：未闭合的调用不产出 span（不伪造结束时间）', () => {
  const builder = new TraceSpanBuilder({ traceIdFactory: () => 'trace', spanIdFactory: ids() });
  builder.consume(ev('tool_call', { callId: 'c9', name: 'shell', args: {} }));
  assert.deepStrictEqual([...builder.drain()], [], '有 call 无 result 时不得产出 span');
});

test('TraceSpanBuilder：model 事件产出 model span 并累计 token；drain 输出会话汇总', () => {
  const builder = new TraceSpanBuilder({ traceIdFactory: () => 't', spanIdFactory: ids() });
  builder.consume(
    ev('model', {
      model: 'deepseek-chat',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
  );
  builder.consume(ev('tool_call', { callId: 'c1', name: 'grep', args: {} }));
  builder.consume(ev('tool_result', { callId: 'c1', ok: true }));
  const spans = builder.drain();

  const modelSpan = spans.find((s) => s.name === 'model.deepseek-chat');
  assert.ok(modelSpan !== undefined, '应有 model span');
  const modelAttrs = new Map(
    (modelSpan!.attributes ?? []).map((a) => [a.key, a.value.stringValue]),
  );
  assert.strictEqual(modelAttrs.get('tokens.total'), '15');

  const sessionSpan = spans.find((s) => s.name === 'session');
  assert.ok(sessionSpan !== undefined, 'drain 应含会话汇总 span');
  const sessionAttrs = new Map(
    (sessionSpan!.attributes ?? []).map((a) => [a.key, a.value.stringValue]),
  );
  assert.strictEqual(sessionAttrs.get('session.model_calls'), '1');
  assert.strictEqual(sessionAttrs.get('session.tool_calls'), '1');
  assert.strictEqual(sessionAttrs.get('session.tokens'), '15');
  assert.deepStrictEqual([...builder.drain()], [], 'drain 后缓冲必须清空（不得长期驻留）');
});

test('TraceCollectingEventPort：事件原样透传 + flush 真导出（含 flush 调用）', async () => {
  const inner = new RecordingPort();
  const exporter = new RecordingExporter();
  const port = new TraceCollectingEventPort({
    inner,
    exporter,
    builder: new TraceSpanBuilder({ traceIdFactory: () => 't', spanIdFactory: ids() }),
  });

  port.emit(ev('tool_call', { callId: 'c1', name: 'shell', args: {} }));
  port.emit(ev('tool_result', { callId: 'c1', ok: true }));
  assert.strictEqual(inner.seen.length, 2, '事件必须原样透传给被装饰端口');
  await port.flush();

  assert.strictEqual(exporter.exported.length, 2, '应导出 tool span + session span');
  assert.strictEqual(exporter.flushes, 1, 'flush 应真正下推到导出器');
  assert.strictEqual(port.innerName(), 'recording');
});

test('TraceCollectingEventPort：会话切换（session_meta）自动冲刷上一会话', async () => {
  const exporter = new RecordingExporter();
  const port = new TraceCollectingEventPort({
    inner: new RecordingPort(),
    exporter,
    builder: new TraceSpanBuilder({ traceIdFactory: () => 't', spanIdFactory: ids() }),
  });
  port.emit(
    ev('model', { model: 'm', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
  );
  port.emit({
    id: 'meta',
    type: 'session_meta',
    sessionId: 's2',
    timestamp: '2026-09-19T10:00:02.000Z',
    payload: { workspace: '/w' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(exporter.exported.length >= 2, '新会话首条事件到来时应冲刷上一会话的 span');
});

test('TraceExporterAssembly：未设端点时**原样返回**（零行为变更）；设了才包装', () => {
  const base = new RecordingPort();
  assert.strictEqual(TraceExporterAssembly.wrap(base, {}), base, '无端点必须零行为变更');
  assert.strictEqual(TraceExporterAssembly.enabled({}), false);

  const wrapped = TraceExporterAssembly.wrap(base, {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
    OMNI_OTLP_SERVICE_NAME: 'omni-test',
  });
  assert.notStrictEqual(wrapped, base);
  assert.strictEqual(wrapped.name, 'trace-collecting');
  assert.strictEqual(
    wrapped.flush !== undefined,
    true,
    '包装后必须实现 flush（供 Agent finally 调用）',
  );
  assert.strictEqual(TraceExporterAssembly.enabled({ OTEL_EXPORTER_OTLP_ENDPOINT: ' x ' }), true);
});

test('TraceExporterAssembly：导出器按端点构造（空端点回落 no-op）', () => {
  assert.strictEqual(TraceExporterAssembly.exporterFor('').name, 'noop');
  assert.strictEqual(TraceExporterAssembly.exporterFor('http://c:4318/v1/traces').name, 'otlp');
});
