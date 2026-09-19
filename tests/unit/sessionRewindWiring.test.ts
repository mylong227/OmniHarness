/**
 * `threads.rewind` 接线单测（F4 重生成的服务端真回退）。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`SessionRewindService` 写了、有单测，但**只被自己的单测引用**
 * ——检测器把它判为「不可达」。前端 `regenerate()` 彼时只截断视图层，服务端 jsonl 里被顶掉的那一轮仍在，
 * 于是「重生成」实际是「接着旧答案再来一轮」，刷新页面旧回答还会复活。本文件钉住接线后的行为：
 *   ① RPC 真把持久化事件流截断到 `keepEventId`（含），且 `threads.get` 随后读到的是截断后的流；
 *   ② 未知会话 / 缺参数 / 事件不属于该会话 一律如实回 `ok:false` + 原因（不抛错、不写盘）；
 *   ③ 无需截断（keepEventId 已是末条）时不写盘（`dropped:0`），避免无意义落盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServer } from '../../src/server/core/appServer.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 回退结果形（与 `threads.rewind` 的 result 一致）。 */
interface RewindResult {
  /** 是否成功。 */
  readonly ok: boolean;
  /** 保留条数（成功时）。 */
  readonly kept?: number;
  /** 丢弃条数（成功时）。 */
  readonly dropped?: number;
  /** 失败原因（ok=false 时）。 */
  readonly error?: string;
}

/** 造一条会话事件。 */
const ev = (
  id: string,
  type: SessionEvent['type'],
  payload: unknown,
  at: string,
): SessionEvent => ({
  id,
  type,
  sessionId: 's-rewind',
  timestamp: at,
  payload,
});

/** 四事件样本（u1 → a1 → u2 → a2）。 */
const SAMPLE: readonly SessionEvent[] = [
  ev('u1', 'user', { content: '第一问' }, '2026-09-19T10:00:00.000Z'),
  ev('a1', 'assistant', { content: '第一答' }, '2026-09-19T10:00:01.000Z'),
  ev('u2', 'user', { content: '第二问' }, '2026-09-19T10:00:02.000Z'),
  ev('a2', 'assistant', { content: '第二答' }, '2026-09-19T10:00:03.000Z'),
];

/** 记录型传输：捕获服务端下行消息，向服务端投递上行请求。 */
class RecordingTransport implements Transport {
  /** 服务端已发出的全部消息。 */
  public readonly sent: RpcMessage[] = [];
  /** 服务端注册的入站回调。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /**
   * 发送消息（记录）。
   * @param message 待发送消息
   * @returns 无返回值
   */
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }

  /**
   * 注册入站回调。
   * @param callback 入站消息回调
   * @returns 无返回值
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 向服务端投递一条上行消息。
   * @param message 上行消息
   * @returns 无返回值
   */
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }
}

/**
 * 等待带指定 id 的响应帧（跳过服务端通知）。
 * @param transport 记录型传输
 * @param id 请求 id
 * @returns 响应帧（result 或 error）
 */
async function waitForResponse(
  transport: RecordingTransport,
  id: number,
): Promise<{ result?: unknown; error?: { message: string } }> {
  for (let i = 0; i < 400; i += 1) {
    const found = transport.sent.find(
      (message) => 'id' in message && !('method' in message) && message.id === id,
    );
    if (found !== undefined) {
      return found as { result?: unknown; error?: { message: string } };
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
  throw new Error(`RPC 响应超时（id=${String(id)}）`);
}

/**
 * 经真实 AppServer 的传输层打一发 RPC（走注册的真实 handler）。
 * @param transport 记录型传输
 * @param method RPC 方法名
 * @param params RPC 参数
 * @returns RPC result（未做类型收窄，由调用方断言）
 */
async function rpc(
  transport: RecordingTransport,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = (transport.sent.length + 1) * 1000 + Math.floor(Math.random() * 1000);
  transport.deliver({ jsonrpc: '2.0', id, method, params });
  const reply = await waitForResponse(transport, id);
  if (reply.error !== undefined) {
    throw new Error(`RPC ${method} 失败: ${reply.error.message}`);
  }
  return reply.result;
}

/**
 * 建真实 AppServer（内存存储 + 记录型传输）。
 * @param storage 会话存储（预置事件）
 * @returns app-server 与记录型传输
 */
function buildServer(storage: MemoryStorage): { app: AppServer; transport: RecordingTransport } {
  const transport = new RecordingTransport();
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 4,
    model: new MockModel(),
    storage,
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const app = new AppServer({ config, transport, modelOverrideEnabled: false });
  return { app, transport };
}

test('threads.rewind：真截断服务端事件流，随后 threads.get 读到的是截断后的流', async () => {
  const storage = new MemoryStorage();
  await storage.save('s-rewind', SAMPLE);
  const { transport } = buildServer(storage);

  const before = (await rpc(transport, 'threads.get', { threadId: 's-rewind' })) as {
    items: readonly SessionEvent[];
  };
  assert.strictEqual(before.items.length, 4, '回退前应是完整四事件流');

  const out = (await rpc(transport, 'threads.rewind', {
    threadId: 's-rewind',
    keepEventId: 'u2',
  })) as RewindResult;
  assert.strictEqual(out.ok, true, `回退应成功，实际：${JSON.stringify(out)}`);
  assert.strictEqual(out.kept, 3);
  assert.strictEqual(out.dropped, 1);

  // 唯一事实源（storage）已被截断：这是「重生成不是接着旧答案」的判据。
  const persisted = await storage.load('s-rewind');
  assert.deepStrictEqual(
    persisted.map((e) => e.id),
    ['u1', 'a1', 'u2'],
  );
  const after = (await rpc(transport, 'threads.get', { threadId: 's-rewind' })) as {
    items: readonly SessionEvent[];
  };
  assert.deepStrictEqual(
    after.items.map((e) => e.id),
    ['u1', 'a1', 'u2'],
    'RPC 与读取路径必须看到同一份截断结果',
  );
});

test('threads.rewind：未知会话 / 缺 keepEventId / 事件不属于该会话 一律 ok:false 且不写盘', async () => {
  const storage = new MemoryStorage();
  await storage.save('s-rewind', SAMPLE);
  const { transport } = buildServer(storage);

  const unknown = (await rpc(transport, 'threads.rewind', {
    threadId: 'no-such',
    keepEventId: 'u1',
  })) as RewindResult;
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error ?? '', /会话不存在/);

  const missing = (await rpc(transport, 'threads.rewind', {
    threadId: 's-rewind',
  })) as RewindResult;
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error ?? '', /keepEventId/);

  const foreign = (await rpc(transport, 'threads.rewind', {
    threadId: 's-rewind',
    keepEventId: 'not-in-this-session',
  })) as RewindResult;
  assert.strictEqual(foreign.ok, false);
  assert.match(foreign.error ?? '', /不在该会话/);

  const persisted = await storage.load('s-rewind');
  assert.strictEqual(persisted.length, 4, '任何失败路径都不得改动事实源');
});

test('threads.rewind：keepEventId 已是末条 ⇒ dropped:0 且不重写存档', async () => {
  const storage = new MemoryStorage();
  await storage.save('s-rewind', SAMPLE);
  const { transport } = buildServer(storage);

  const out = (await rpc(transport, 'threads.rewind', {
    threadId: 's-rewind',
    keepEventId: 'a2',
  })) as RewindResult;
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dropped, 0);
  assert.strictEqual((await storage.load('s-rewind')).length, 4);
});
