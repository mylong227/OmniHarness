// WebLiveView 单测（#B3 web）：验证 onToolInput 经 broadcaster.notify 推送 thread.tool_input，
// 且 id/name 缺失时以 null 上报、partialJson 原样透传。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebLiveView, type LiveBroadcaster } from '../../src/adapters/live/webLiveView.js';

function mockBroadcaster(): { bc: LiveBroadcaster; calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { bc: { notify: (method, params) => calls.push({ method, params }) }, calls };
}

test('onToolInput → notify(thread.tool_input)，字段正确透传', () => {
  const { bc, calls } = mockBroadcaster();
  const view = new WebLiveView(bc);
  view.onToolInput({ id: 'c1', name: 'shell.run', partialJson: '{"cmd":"echo' });
  assert.strictEqual(calls.length, 1, '应广播一次');
  assert.strictEqual(calls[0]!.method, 'thread.tool_input');
  assert.deepStrictEqual(calls[0]!.params, {
    id: 'c1',
    name: 'shell.run',
    partialJson: '{"cmd":"echo',
  });
});

test('id/name 缺失时以 null 上报（前端仍可按 null 降级忽略占位）', () => {
  const { bc, calls } = mockBroadcaster();
  const view = new WebLiveView(bc);
  view.onToolInput({ partialJson: '{"x":1}' });
  assert.deepStrictEqual(calls[0]!.params, { id: null, name: null, partialJson: '{"x":1}' });
});

test('onTextDelta → notify(thread.text_delta)，增量片段原样透传', () => {
  const { bc, calls } = mockBroadcaster();
  const view = new WebLiveView(bc);
  view.onTextDelta('你好');
  view.onTextDelta('，世界');
  assert.strictEqual(calls.length, 2, '每一段增量各广播一次');
  assert.strictEqual(calls[0]!.method, 'thread.text_delta');
  assert.deepStrictEqual(calls[0]!.params, { text: '你好' });
  // 关键：回传的是增量片段而非累积全文——前端据此 append 拼接，语义不能含糊。
  assert.deepStrictEqual(calls[1]!.params, { text: '，世界' });
});

test('onTextDelta 空串也如实广播（是否丢弃由消费方决定，适配器不替它猜）', () => {
  const { bc, calls } = mockBroadcaster();
  const view = new WebLiveView(bc);
  view.onTextDelta('');
  assert.deepStrictEqual(calls[0]!.params, { text: '' });
});
