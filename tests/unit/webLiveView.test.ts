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
