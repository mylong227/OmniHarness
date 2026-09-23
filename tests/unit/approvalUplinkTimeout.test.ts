/**
 * 审批上行**不会永久挂起**的回归（2026-09-22，审计 P2）。
 *
 * 被修的缺陷：`ServerEventBridge.requestApproval` 只登记 resolver 后**死等**，而客户端可随时消失
 * （关页面 / 网络断）。UI 档 `approval=ask` 下一次工具调用就让回合永久挂起——
 * `ToolGate` 的 `await decide` 永不 settle ⇒ 回合不返回、`activeTurns` 永久 running、
 * `POST /rpc` 悬挂、pending 表泄漏。
 *
 * 本测试钉住三条兑现路径与一条幂等性：
 * ① 超时 ⇒ deny（fail-closed，绝不 hang）；
 * ② 客户端全部断开 ⇒ `denyAllPending` 立即 deny（不必等超时窗口）；
 * ③ 正常响应 ⇒ allow，且晚到的超时不会二次兑现；
 * ④ 传输层：SSE/WS 连接关闭确实触发 `setOnAllClientsGone`（只在「有→无」跃迁上触发一次）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ServerEventBridge } from '../../src/server/core/serverEventBridge.js';
import { HttpBridgeTransport } from '../../src/server/transport/httpBridgeTransport.js';
import { LineTransport } from '../../src/server/transport/lineTransport.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { ApprovalRequest } from '../../src/ports/runtime/approval.js';
import type { WsConnection } from '../../src/server/transport/wsConnection.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 只记录下行消息的假传输（不发网络）。 */
class RecordingTransport implements Transport {
  /** 已下发的通知（用于断言审批请求确实上行过）。 */
  public readonly sent: RpcMessage[] = [];
  /** 断开回调（由 Bridge/AppServer 注册）。 */
  public gone: (() => void) | undefined;

  /**
   * 记录一条下行消息。
   * @param message RPC 消息（响应或通知）
   * @returns 无返回值
   */
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }

  /**
   * 入站订阅（本测试不需要入站消息）。
   * @returns 无返回值
   */
  public onMessage(): void {
    // 测试不需要入站
  }

  /**
   * 注册断连回调（Bridge/AppServer 用它兑现挂起审批）。
   * @param callback 无参回调
   * @returns 无返回值
   */
  public setOnAllClientsGone(callback: () => void): void {
    this.gone = callback;
  }
}

/** 一次审批请求样本。 */
const REQUEST: ApprovalRequest = {
  sessionId: 'sess_timeout_probe',
  toolName: 'shell',
  target: 'rm -rf /tmp/x',
};

test('① 审批上行超时按 deny 兑现（fail-closed，不再永久挂起）', async () => {
  const transport = new RecordingTransport();
  const bridge = new ServerEventBridge({ transport, approvalTimeoutMs: 40 });
  const started = Date.now();
  const decision = await bridge.requestApproval(REQUEST);
  const elapsed = Date.now() - started;
  assert.strictEqual(decision, 'deny', '超时必须兑现为 deny（保守拒绝）');
  assert.ok(elapsed >= 30, `应在超时后兑现，实际 ${elapsed}ms`);
  assert.strictEqual(bridge.pendingApprovalCount(), 0, '超时后不得残留挂起条目');
  assert.strictEqual(transport.sent.length, 1, '审批请求必须已上行');
});

test('② 客户端全部断开 ⇒ denyAllPending 立即兑现（不必等超时）', async () => {
  const transport = new RecordingTransport();
  const bridge = new ServerEventBridge({ transport, approvalTimeoutMs: 60_000 });
  const pending = bridge.requestApproval(REQUEST);
  await sleep(5);
  assert.strictEqual(bridge.pendingApprovalCount(), 1);
  const settled = bridge.denyAllPending('测试：客户端断开');
  assert.strictEqual(settled, 1, '应兑现 1 条挂起审批');
  assert.strictEqual(await pending, 'deny', '断连必须兑现为 deny');
  assert.strictEqual(bridge.pendingApprovalCount(), 0);
  assert.strictEqual(bridge.denyAllPending('再调一次'), 0, '无挂起时返回 0（幂等）');
});

test('③ 正常响应 ⇒ allow，且晚到超时不会二次兑现', async () => {
  const transport = new RecordingTransport();
  const bridge = new ServerEventBridge({ transport, approvalTimeoutMs: 40 });
  const pending = bridge.requestApproval(REQUEST);
  await sleep(5);
  const notified = transport.sent[0];
  const params = (notified as { params?: { requestId?: string } }).params;
  const requestId = params?.requestId ?? '';
  assert.ok(requestId !== '', '审批通知应带 requestId');
  bridge.respondApproval({ requestId, decision: 'allow' });
  assert.strictEqual(await pending, 'allow', '用户允许必须兑现为 allow');
  assert.strictEqual(bridge.pendingApprovalCount(), 0);
  await sleep(60); // 越过超时窗口：不得因残留定时器抛错或改判
  assert.strictEqual(bridge.pendingApprovalCount(), 0);
});

test('④ 传输层：SSE/WS 关闭触发一次「全部断开」回调（仅在有→无跃迁时）', async () => {
  const transport = new HttpBridgeTransport();
  let gone = 0;
  transport.setOnAllClientsGone(() => {
    gone += 1;
  });
  // SSE：注册两个客户端，全部关闭才触发
  const mkSse = (): ServerResponse => {
    const emitter = new EventEmitter() as unknown as ServerResponse;
    return emitter;
  };
  const sse1 = mkSse();
  const sse2 = mkSse();
  transport.registerSse(sse1);
  transport.registerSse(sse2);
  sse1.emit('close');
  assert.strictEqual(gone, 0, '仍有客户端在线时不得触发');
  sse2.emit('close');
  assert.strictEqual(gone, 1, '最后一个客户端断开应触发一次');
  // WS 客户端同样参与判定
  const ws = {
    authorization: undefined,
    send: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  } as unknown as WsConnection;
  transport.registerWs(ws);
  assert.strictEqual(gone, 1, '新客户端接入不得触发');
  ws.onClose?.();
  assert.strictEqual(gone, 2, 'WS 关闭同样应触发（集合变空）');
});

test('⑤ 未支持断连信号的传输不影响既有能力（可选能力，非必需）', () => {
  // LineTransport 不实现 setOnAllClientsGone：AppServer 用**可选调用**，必须不抛错。
  // 变量显式标注为 Transport：断连信号是端口上的**可选**能力，具体类上不存在是合法状态。
  const line: Transport = new LineTransport(
    () => undefined,
    () => undefined,
  );
  assert.strictEqual(line.setOnAllClientsGone, undefined);
  assert.doesNotThrow(() => line.setOnAllClientsGone?.(() => undefined));
});
