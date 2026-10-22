/**
 * 运行清单 + `invoke_agent` span 判据（2026-10-22 评测契约第一片）。
 *
 * 锁三件事：
 * 1. 清单是**确定性**的（工具顺序无关、提示只哈希不落原文）；
 * 2. `session_meta` 真的带上清单（不是只在 builder 里存在）；
 * 3. 有清单的会话在 drain 时多出 `invoke_agent` span，没有清单的旧事件流保持原样
 *    （既有 golden trace / 判据零变化）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { RunManifestBuilder } from '../../src/core/runManifestBuilder.ts';
import { eventFactory } from '../../src/core/eventFactory.ts';
import { TraceSpanBuilder } from '../../src/observability/traceSpanBuilder.ts';

const NOW = new Date('2026-10-22T00:00:00.000Z');

test('RunManifestBuilder：工具顺序无关、提示只哈希、字段稳定', () => {
  const a = RunManifestBuilder.build({
    workspace: 'D:/ws',
    model: 'm',
    reasoning: 'high',
    planMode: false,
    exposureMode: 'plan',
    tools: ['write_file', 'read_file', 'read_file'],
    prompt: 'hello',
    now: NOW,
  });
  const b = RunManifestBuilder.build({
    workspace: 'D:/ws',
    model: 'm',
    reasoning: 'high',
    planMode: false,
    exposureMode: 'plan',
    tools: ['read_file', 'write_file'],
    prompt: 'hello',
    now: NOW,
  });
  assert.deepStrictEqual(a.toolNames, ['read_file', 'write_file']);
  assert.strictEqual(a.toolCount, 2);
  assert.strictEqual(a.toolHash, b.toolHash);
  assert.strictEqual(a.promptHash, b.promptHash);
  assert.strictEqual(a.promptChars, 5);
  assert.ok(!JSON.stringify(a).includes('hello'), '提示原文不得进入清单');
  assert.strictEqual(a.startedAt, '2026-10-22T00:00:00.000Z');
});

test('EventFactory：session_meta 必须携带 manifest', () => {
  const manifest = RunManifestBuilder.build({
    workspace: 'D:/ws',
    model: 'm',
    planMode: true,
    exposureMode: 'plan',
    tools: ['read_file'],
    prompt: 'task',
    now: NOW,
  });
  const event = eventFactory.sessionMeta('s1', 'D:/ws', 'm', manifest);
  const payload = event.payload as Record<string, unknown>;
  assert.deepStrictEqual(payload['manifest'], manifest);
  assert.strictEqual(payload['workspace'], 'D:/ws');
});

test('TraceSpanBuilder：有 manifest 的会话产出 invoke_agent span', () => {
  const manifest = RunManifestBuilder.build({
    workspace: 'D:/ws',
    model: 'm',
    planMode: false,
    exposureMode: 'plan',
    tools: ['read_file'],
    prompt: 'task',
    now: NOW,
  });
  const ids = ['a', 'b', 'c'];
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace',
    spanIdFactory: () => ids.shift() ?? 'z',
  });
  builder.consume(eventFactory.sessionMeta('s1', 'D:/ws', 'm', manifest));
  builder.consume(
    eventFactory.model('s1', { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'm'),
  );
  const spans = builder.drain();
  const agent = spans.find((span) => span.name === 'invoke_agent');
  assert.ok(agent !== undefined, '必须产出 agent 级 span');
  const attrs = new Map(
    (agent?.attributes ?? []).map((entry) => [
      entry.key,
      typeof entry.value === 'object' && entry.value !== null
        ? JSON.stringify(entry.value)
        : String(entry.value),
    ]),
  );
  assert.match(attrs.get('gen_ai.operation.name') ?? '', /invoke_agent/u);
  assert.match(attrs.get('harness.manifest.prompt_hash') ?? '', new RegExp(manifest.promptHash));
  assert.strictEqual(attrs.get('session.tokens'), '{"intValue":"15"}');
});

test('TraceSpanBuilder：没有 manifest 的旧事件流不产 invoke_agent（golden 不变）', () => {
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace',
    spanIdFactory: () => 'id',
  });
  builder.consume(eventFactory.sessionMeta('s1', 'D:/ws', 'm'));
  builder.consume(
    eventFactory.model('s1', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, 'm'),
  );
  assert.strictEqual(
    builder.drain().some((span) => span.name === 'invoke_agent'),
    false,
  );
});

test('TraceSpanBuilder：只有 manifest、没有调用时不伪造 span；drain 后不重复', () => {
  const manifest = RunManifestBuilder.build({
    workspace: 'D:/ws',
    model: 'm',
    planMode: false,
    exposureMode: 'plan',
    tools: [],
    prompt: 'task',
    now: NOW,
  });
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace',
    spanIdFactory: () => 'id',
  });
  builder.consume(eventFactory.sessionMeta('s1', 'D:/ws', 'm', manifest));
  assert.deepStrictEqual(builder.drain(), [], '没有模型/工具调用不产 span');

  const second = new TraceSpanBuilder({
    traceIdFactory: () => 'trace',
    spanIdFactory: () => 'id',
  });
  second.consume(eventFactory.sessionMeta('s1', 'D:/ws', 'm', manifest));
  second.consume(
    eventFactory.model('s1', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, 'm'),
  );
  assert.strictEqual(second.drain().filter((span) => span.name === 'invoke_agent').length, 1);
  assert.deepStrictEqual(second.drain(), [], '第二次 drain 不得重复上报');
});

test('TraceSpanBuilder：进程内切换会话时 invoke_agent 必须用新会话 id/起点', () => {
  const firstManifest = RunManifestBuilder.build({
    workspace: 'D:/a',
    model: 'm1',
    planMode: false,
    exposureMode: 'off',
    tools: [],
    prompt: 'a',
    now: NOW,
  });
  const secondManifest = RunManifestBuilder.build({
    workspace: 'D:/b',
    model: 'm2',
    planMode: false,
    exposureMode: 'plan',
    tools: [],
    prompt: 'b',
    now: NOW,
  });
  const builder = new TraceSpanBuilder({
    traceIdFactory: () => 'trace',
    spanIdFactory: () => 'id',
  });
  builder.consume(eventFactory.sessionMeta('s1', 'D:/a', 'm1', firstManifest));
  builder.consume(
    eventFactory.model('s1', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, 'm1'),
  );
  builder.consume(eventFactory.sessionMeta('s2', 'D:/b', 'm2', secondManifest));
  builder.consume(
    eventFactory.model('s2', { promptTokens: 3, completionTokens: 2, totalTokens: 5 }, 'm2'),
  );
  const spans = builder.drain();
  const agent = spans.find((span) => span.name === 'invoke_agent');
  assert.ok(agent !== undefined);
  const attrs = new Map((agent?.attributes ?? []).map((entry) => [entry.key, entry.value]));
  assert.deepStrictEqual(attrs.get('session.id'), { stringValue: 's2' });
  assert.deepStrictEqual(attrs.get('gen_ai.request.model'), { stringValue: 'm2' });
  assert.deepStrictEqual(attrs.get('harness.manifest.exposure_mode'), { stringValue: 'plan' });
});
