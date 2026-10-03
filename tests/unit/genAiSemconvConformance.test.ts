/**
 * **GenAI semconv 一致性判据**（G23，2026-10-03 第十一轮）。
 *
 * ## 它钉住什么（以及**不**钉住什么）
 *
 * 钉住三件事，任何一件变动都要显式改本文件：
 *  1. 我们依据的 semconv **版本锚**（{@link SEMCONV_VERSION}）；
 *  2. 我们发出的 **GenAI 标准键集**（`gen_ai.*`）；
 *  3. 我们**保留**的过渡键集（`tool.*` / `tokens.*` / `session.*`）——**这才是"不改名"的保证**：
 *     断言旧键仍在，防止有人把"对齐 semconv"做成"直接改名"（那是单向门：历史 trace 与查询面板一起失效）。
 *
 * **不**钉住："上游规范此刻是否仍然这样写"——门禁不联网，做不到实时校验。故这里采用"版本 + 键集一起钉死"
 * 的做法：升级 {@link SEMCONV_VERSION} 就会红，逼人回去复核键名。这一点写在被测文件的 JSDoc 里，
 * 不把它伪装成实时一致性校验。
 *
 * ## 另外两条数值/口径判据
 *
 * - **数值必须走 `intValue`**（proto3 JSON 的 int64 形态是字符串）：塞 `stringValue` 会让标准 GenAI
 *   后端无法按类型分派，token/计数在那些后端上直接读不出来；
 * - **`cache_read` 是 `input_tokens` 的子集**（semconv token-metrics 脚注）：故本仓只发
 *   `gen_ai.usage.input_tokens`（含缓存读的总量），**绝不**让缓存读与输入相加。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TraceSpanBuilder } from '../../src/observability/traceSpanBuilder.js';
import { GEN_AI_KEYS, LEGACY_KEYS, SEMCONV_VERSION } from '../../src/observability/genAiSemconv.js';
import type { Span } from '../../src/observability/otlpTraceExporter.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * 造一条事件。
 * @param type 事件类型。
 * @param payload 载荷。
 * @param ts 时间戳（毫秒，仅用于可读性）。
 * @param sessionId 会话 id。
 * @returns 会话事件。
 */
function eventOf(
  type: string,
  payload: Record<string, unknown>,
  ts = 0,
  sessionId = 's1',
): SessionEvent {
  return {
    id: `${type}-${String(ts)}`,
    type,
    sessionId,
    timestamp: new Date(1_700_000_000_000 + ts).toISOString(),
    payload,
  } as SessionEvent;
}

/**
 * 跑一遍构造器，产出三类 span（顺序确定性由注入的 id 工厂保证）。
 * @returns 全部 span。
 */
function buildSpans(): readonly Span[] {
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
  return builder.drain();
}

/**
 * 取某 span 的属性表（键 → 值对象）。
 * @param span 目标 span。
 * @returns 键到 AnyValue 的映射。
 */
function attrsOf(span: Span): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const attribute of span.attributes ?? []) {
    out[attribute.key] = attribute.value as unknown as Record<string, unknown>;
  }
  return out;
}

/**
 * 按名取 span。
 * @param spans 全部 span。
 * @param prefix span 名前缀。
 * @returns 首个匹配的 span。
 */
function spanByPrefix(spans: readonly Span[], prefix: string): Span {
  const found = spans.find((s) => s.name.startsWith(prefix));
  assert.ok(
    found !== undefined,
    `未产出 ${prefix} 开头的 span（实际：${spans.map((s) => s.name).join(', ')}）`,
  );
  return found;
}

test('版本锚：SEMCONV_VERSION 固定为已复核的版本（升级即红，逼人复核键名）', () => {
  assert.strictEqual(
    SEMCONV_VERSION,
    '1.44.0',
    '升级版本锚必须同时复核 gen_ai.* 键名与下面的键集断言——这正是本用例存在的原因',
  );
});

test('工具 span：并行发标准键，且**过渡键一个都没少**（"不改名"的保证）', () => {
  const tool = spanByPrefix(buildSpans(), 'tool.');
  const attrs = attrsOf(tool);
  // ① 标准键在
  // ① 标准键在。**用字面键名断言**：若只断言常量，builder 与常量一起改名时恒等成立 ⇒ 判据永远不会红
  //    （本用例首版就是这么写的，变异测试当场证明它抓不到改名）。
  assert.strictEqual(attrs['gen_ai.tool.name']?.stringValue, 'glob');
  assert.strictEqual(attrs['gen_ai.operation.name']?.stringValue, 'execute_tool');
  assert.strictEqual(GEN_AI_KEYS.toolName, 'gen_ai.tool.name', '常量必须等于已复核的键名');
  // ② 过渡键仍在（有人把"对齐"做成"改名"时这里会红——那扇门是单向的：历史 trace 与查询面板一起失效）
  for (const key of ['tool.name', 'tool.ok', 'session.id']) {
    assert.ok(
      key in attrs,
      `过渡键 ${key} 必须保留（改名是单向门：历史 trace 与查询面板会一起失效）`,
    );
  }
  assert.strictEqual(attrs['tool.name']?.stringValue, 'glob');
  assert.strictEqual(attrs['tool.ok']?.stringValue, 'true');
  assert.strictEqual(LEGACY_KEYS.toolName, 'tool.name', '常量必须等于已复核的过渡键名');
  assert.strictEqual(LEGACY_KEYS.toolOk, 'tool.ok');
  assert.strictEqual(LEGACY_KEYS.sessionId, 'session.id');
});

test('模型 span：标准用量键 + 过渡键并存；不臆造第二个模型名', () => {
  const model = spanByPrefix(buildSpans(), 'model.');
  const attrs = attrsOf(model);
  assert.strictEqual(attrs['gen_ai.operation.name']?.stringValue, 'chat');
  assert.strictEqual(attrs['gen_ai.request.model']?.stringValue, 'deepseek-chat');
  assert.strictEqual(
    attrs['gen_ai.response.model']?.stringValue,
    'deepseek-chat',
    '事件里只有一个 model 字段 ⇒ 响应模型与请求同名，不得另编一个值',
  );
  for (const key of [
    'model.name',
    'tokens.prompt',
    'tokens.completion',
    'tokens.total',
    'session.id',
  ]) {
    assert.ok(key in attrs, `过渡键 ${key} 必须保留`);
  }
  assert.strictEqual(LEGACY_KEYS.modelName, 'model.name');
  assert.strictEqual(LEGACY_KEYS.tokensPrompt, 'tokens.prompt');
  assert.strictEqual(LEGACY_KEYS.tokensCompletion, 'tokens.completion');
  assert.strictEqual(LEGACY_KEYS.tokensTotal, 'tokens.total');
});

test('数值属性走 intValue（proto3 JSON 的 int64 字符串形态），不得再塞 stringValue', () => {
  for (const span of buildSpans()) {
    for (const attribute of span.attributes ?? []) {
      if (attribute.key === LEGACY_KEYS.toolOk) {
        continue; // 布尔以字符串承载是本仓既有口径，不在本次数值迁移范围内
      }
      const value = attribute.value as Record<string, unknown>;
      if (
        /^(tokens\.|session\.(tool_calls|model_calls|tokens)|gen_ai\.usage\.)/.test(attribute.key)
      ) {
        assert.ok(
          typeof value.intValue === 'string',
          `${attribute.key} 必须用 intValue（字符串 int64 形态），实际 ${JSON.stringify(value)}`,
        );
        assert.ok(
          value.stringValue === undefined,
          `${attribute.key} 不得再用 stringValue 承载数字（标准后端无法按类型分派）`,
        );
        assert.match(
          String(value.intValue),
          /^-?\d+$/,
          `${attribute.key} 的 intValue 必须是整数字符串`,
        );
      }
    }
  }
});

test('缓存读口径：input_tokens 是含缓存读的总量，绝不与缓存读相加', () => {
  // 造一条 usage 里**同时**有 promptTokens 与 cachedPromptTokens 的模型事件：
  // 期望 gen_ai.usage.input_tokens == promptTokens（不是 prompt + cached）。
  let seq = 0;
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace-fixed',
    spanIdFactory: () => `span-${String(++seq)}`,
  });
  builder.consume(eventOf('session_meta', { workspace: '/tmp/ws' }, 0));
  builder.consume(
    eventOf(
      'model',
      {
        model: 'deepseek-chat',
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedPromptTokens: 40,
        },
      },
      10,
    ),
  );
  const model = spanByPrefix(builder.drain(), 'model.');
  const attrs = attrsOf(model);
  assert.strictEqual(
    attrs[GEN_AI_KEYS.usageInputTokens]?.intValue,
    '100',
    'input_tokens 是 100（含其中 40 命中缓存），不是 140——cache_read 是 input 的子集',
  );
  assert.strictEqual(attrs[GEN_AI_KEYS.usageOutputTokens]?.intValue, '20');
});
