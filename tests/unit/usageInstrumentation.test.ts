import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';

/** 构造一个可查 allEvents 的 recorder（#S29 / live 跑分 usage 落库验证）。 */
function recorder(): SessionRecorder {
  return new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 'sess-test');
}

test('recorder.usage 发射 model 事件且 payload 携带 usage（live token 计量来源）', () => {
  const rec = recorder();
  rec.usage({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });

  const events = rec.allEvents();
  const modelEvents = events.filter((e) => e.type === 'model');
  assert.strictEqual(modelEvents.length, 1, '应恰好发射一条 model 事件');
  const usage = (modelEvents[0]?.payload as { usage?: unknown }).usage;
  assert.deepStrictEqual(usage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
});

test('多次模型调用的 usage 各自落库、可分别聚合', () => {
  const rec = recorder();
  rec.usage({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  rec.usage({ promptTokens: 30, completionTokens: 2, totalTokens: 32 });

  const modelEvents = rec.allEvents().filter((e) => e.type === 'model');
  assert.strictEqual(modelEvents.length, 2);
  const total = modelEvents.reduce(
    (acc, e) => acc + (e.payload as { usage: { totalTokens: number } }).usage.totalTokens,
    0,
  );
  assert.strictEqual(total, 43);
});

test('无 usage 时不发射 model 事件（绝不臆造成本）', () => {
  const rec = recorder();
  rec.assistant('hello');
  assert.strictEqual(
    rec.allEvents().filter((e) => e.type === 'model').length,
    0,
    '未记录 usage 时不应有 model 事件',
  );
});
