// CompositeLiveView 单测（#B3 web）：验证组合 sink 的转发 / addSink / removeSink / 去重。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompositeLiveView } from '../../src/adapters/live/compositeLiveView.js';
import type { ToolInputSink } from '../../src/ports/toolInputSink.js';
import type { ToolInputDelta } from '../../src/ports/model.js';

function sinkSpy(name: string): { sink: ToolInputSink; deltas: ToolInputDelta[] } {
  const deltas: ToolInputDelta[] = [];
  return { sink: { name, onToolInput: (d) => deltas.push(d) }, deltas };
}

test('构造传入 + addSink 后 onToolInput 转发给所有子 sink', () => {
  const a = sinkSpy('a');
  const b = sinkSpy('b');
  const composite = new CompositeLiveView([a.sink]);
  composite.addSink(b.sink);
  const d: ToolInputDelta = { id: 'c1', name: 'shell.run', partialJson: '{"x":' };
  composite.onToolInput(d);
  assert.strictEqual(a.deltas.length, 1, 'a 应收到');
  assert.strictEqual(b.deltas.length, 1, 'b 应收到');
  assert.deepStrictEqual(a.deltas[0], d);
  assert.deepStrictEqual(b.deltas[0], d);
});

test('removeSink 后不再转发给被移除的子 sink', () => {
  const a = sinkSpy('a');
  const b = sinkSpy('b');
  const composite = new CompositeLiveView([a.sink, b.sink]);
  composite.removeSink(a.sink);
  composite.onToolInput({ partialJson: 'x' });
  assert.strictEqual(a.deltas.length, 0, 'a 已移除，不应收到');
  assert.strictEqual(b.deltas.length, 1, 'b 仍在，应收到');
});

test('构造空 + addSink 去重（同实例不重复）', () => {
  const a = sinkSpy('a');
  const composite = new CompositeLiveView();
  composite.addSink(a.sink);
  composite.addSink(a.sink);
  composite.onToolInput({ partialJson: 'y' });
  assert.strictEqual(a.deltas.length, 1, '去重后应只收到一次');
});
