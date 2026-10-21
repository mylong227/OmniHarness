import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';

import { HttpBridgeTransport } from '../../src/server/transport/httpBridgeTransport.ts';
import { jsonRpc } from '../../src/server/core/jsonRpc.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

/** 假 SSE 响应：记录写出的帧。 */
class FakeSse {
  public readonly frames: string[] = [];
  /** 注册的 close 回调（本测试不触发）。 */
  private closeHandler: (() => void) | undefined;
  public write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
  public on(event: string, handler: () => void): void {
    if (event === 'close') this.closeHandler = handler;
  }
  public end(): void {
    this.closeHandler?.();
  }
}

function asResponse(fake: FakeSse): ServerResponse {
  return fake as unknown as ServerResponse;
}

function threadEvent(sessionId: string, id: string): ReturnType<typeof jsonRpc.notify> {
  const event = {
    id,
    type: 'user' as const,
    sessionId,
    timestamp: '2026-10-21T00:00:00.000Z',
    seq: 1,
    payload: { content: 'hi' },
  };
  return jsonRpc.notify('thread.event', { threadId: sessionId, event });
}

test('SSE 重连：thread.event 带全局 id，Last-Event-ID 之后的事件重放给新连接', () => {
  const transport = new HttpBridgeTransport();
  const first = new FakeSse();
  transport.sse.register(asResponse(first));

  transport.send(threadEvent('s1', 'e1'));
  transport.send(threadEvent('s2', 'e2'));
  // 非 thread.event 通知不占用重放序号（审批弹窗重放会让用户看到已答过的请求）。
  transport.send(jsonRpc.notify('approval.request', { requestId: 'a1' }));

  assert.match(first.frames[0] ?? '', /^id: 1\ndata: /u);
  assert.match(first.frames[1] ?? '', /^id: 2\ndata: /u);
  assert.doesNotMatch(first.frames[2] ?? '', /^id: /u);

  const resumed = new FakeSse();
  transport.sse.register(asResponse(resumed), 1);
  assert.strictEqual(resumed.frames.length, 1, '只重放 Last-Event-ID 之后的缺口');
  assert.match(resumed.frames[0] ?? '', /^id: 2\ndata: /u);
  assert.match(resumed.frames[0] ?? '', /"e2"/u);
});

test('SSE 重连：非法 / 缺省 Last-Event-ID 不重放（首次连接语义）', () => {
  const transport = new HttpBridgeTransport();
  transport.send(threadEvent('s1', 'e1'));
  const fresh = new FakeSse();
  transport.sse.register(asResponse(fresh));
  assert.deepStrictEqual(fresh.frames, [], '首次连接不应收到历史帧');
});

test('事件 seq：每条事件单调递增，回卷后高水位不回退', () => {
  const log = new AppendOnlyEventLog();
  const recorder = new SessionRecorder(log, new SilentEventPort(), 'seq-session');
  const a = recorder.user('a');
  const b = recorder.assistant('b');
  assert.strictEqual(a.seq, 1);
  assert.strictEqual(b.seq, 2);

  recorder.rewindTo(1);
  const c = recorder.assistant('c');
  assert.strictEqual(c.seq, 3, '回卷后不能复用已发出的序号（否则重连客户端会当重复丢弃）');
});

test('事件 seq：旧存档（无 seq）hydrate 后从长度 + 1 续编，不重号', () => {
  const log = new AppendOnlyEventLog();
  const legacy = [
    { id: 'l1', type: 'user' as const, sessionId: 'legacy', timestamp: 't', payload: {} },
    { id: 'l2', type: 'assistant' as const, sessionId: 'legacy', timestamp: 't', payload: {} },
  ] satisfies SessionEvent[];
  log.hydrate(legacy);
  const recorder = new SessionRecorder(log, new SilentEventPort(), 'legacy');
  const next = recorder.user('new');
  assert.strictEqual(next.seq, 3, '旧存档 2 条 ⇒ 新事件从 3 开始');
  assert.deepStrictEqual(
    log.all().map((event) => event.seq),
    [undefined, undefined, 3],
    '旧事件保持 undefined，不改写存档',
  );
});
