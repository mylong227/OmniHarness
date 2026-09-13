import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerEventBridge } from '../../src/server/core/serverEventBridge.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 记录下行消息的传输桩。 */
class RecordingTransport implements Transport {
  public readonly sent: RpcMessage[] = [];
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }
  public onMessage(): void {}
}

/** 建桥并返回桩。 */
function build(): { bridge: ServerEventBridge; transport: RecordingTransport } {
  const transport = new RecordingTransport();
  return { bridge: new ServerEventBridge({ transport }), transport };
}

test('ServerEventBridge.eventPort：emit 推送 thread.event 通知', () => {
  const { bridge, transport } = build();
  const event: SessionEvent = {
    id: 'e1',
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: '2026-09-11T00:00:00.000Z',
    payload: { text: 'hi' },
  };
  bridge.eventPort().emit(event);
  assert.strictEqual(transport.sent.length, 1);
  const msg = transport.sent[0] as unknown as { method: string; params: { threadId: string } };
  assert.strictEqual(msg.method, 'thread.event');
  assert.strictEqual(msg.params.threadId, 'sess-1');
});

test('ServerEventBridge：审批上行 → 响应 allow 兑现挂起 Promise', async () => {
  const { bridge, transport } = build();
  const pending = bridge.requestApproval({ sessionId: 's', toolName: 'shell', target: 'rm -rf' });
  const req = transport.sent[0] as unknown as {
    method: string;
    params: { requestId: string; toolName: string; target: string };
  };
  assert.strictEqual(req.method, 'approval.request');
  assert.strictEqual(req.params.toolName, 'shell');
  bridge.respondApproval({ requestId: req.params.requestId, decision: 'allow' });
  assert.strictEqual(await pending, 'allow');
});

test('ServerEventBridge：非 allow 的决策一律归一为 deny', async () => {
  const { bridge, transport } = build();
  const pending = bridge.requestApproval({ sessionId: 's', toolName: 'shell', target: 'x' });
  const req = transport.sent[0] as unknown as { params: { requestId: string } };
  bridge.respondApproval({ requestId: req.params.requestId, decision: 'whatever' });
  assert.strictEqual(await pending, 'deny');
});

test('ServerEventBridge：未知 requestId 静默返回 ok，不抛错', () => {
  const { bridge } = build();
  assert.deepEqual(bridge.respondApproval({ requestId: 'nope', decision: 'allow' }), { ok: true });
});

test('ServerEventBridge：同一请求重复响应不产生副作用', async () => {
  const { bridge, transport } = build();
  const pending = bridge.requestApproval({ sessionId: 's', toolName: 'shell', target: 'x' });
  const req = transport.sent[0] as unknown as { params: { requestId: string } };
  bridge.respondApproval({ requestId: req.params.requestId, decision: 'allow' });
  assert.deepEqual(bridge.respondApproval({ requestId: req.params.requestId, decision: 'deny' }), {
    ok: true,
  });
  assert.strictEqual(await pending, 'allow');
});

test('ServerEventBridge.approvalPort：decide 走同一条上行链路', async () => {
  const { bridge, transport } = build();
  const port = bridge.approvalPort();
  assert.strictEqual(port.name, 'server');
  const pending = port.decide({ sessionId: 's', toolName: 'shell', target: 'x' });
  const req = transport.sent[0] as unknown as { params: { requestId: string } };
  bridge.respondApproval({ requestId: req.params.requestId, decision: 'allow' });
  assert.strictEqual(await pending, 'allow');
});
