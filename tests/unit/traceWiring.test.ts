/**
 * T4.5 接线单测：只读 trace 自省从「有实现、无接线」变成「production 可达」。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`ports/intelligence/traceIntrospection.ts` 与
 * `adapters/telemetry/readonlyTraceReader.ts` 写了、有单测，但生产入口不可达。本文件钉住接线后的行为：
 *   ① 存档事件源（SessionEventReader）真读 `.jsonl`，坏行/非法 id/缺失文件 fail-soft；
 *   ② SessionTraceService 三条路径（已加载 / 未加载 / 事件源抛错）；
 *   ③ `trace.read` RPC 起真实 AppServer 打一发（复用会话存储 + 只读投影器）；
 *   ④ 只读保证：返回条目冻结、篡改抛错（无法借道改历史）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEventReader } from '../../src/adapters/telemetry/sessionEventReader.js';
import { SessionTraceService } from '../../src/server/services/sessionTraceService.js';
import type { TraceReadResult } from '../../src/ports/intelligence/traceIntrospection.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import { AppServer } from '../../src/server/core/appServer.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 造一条会话事件（只填本测试关心的字段）。 */
const ev = (
  type: SessionEvent['type'],
  payload: unknown,
  sessionId: string,
  at: string,
): SessionEvent => ({ id: `e-${type}-${at}`, type, sessionId, timestamp: at, payload });

/** 三事件样本（user → tool_call → assistant）。 */
const SAMPLE: readonly SessionEvent[] = [
  ev('user', { content: '开始任务' }, 's-trace', '2026-09-19T10:00:00.000Z'),
  ev('tool_call', { callId: 'c1', name: 'read_file' }, 's-trace', '2026-09-19T10:00:01.000Z'),
  ev('assistant', { content: '完成' }, 's-trace', '2026-09-19T10:00:02.000Z'),
];

/** 记录型传输：捕获服务端下行消息，向服务端投递上行请求。 */
class RecordingTransport implements Transport {
  /** 服务端已发出的全部消息。 */
  public readonly sent: RpcMessage[] = [];
  /** 服务端注册的入站回调。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /**
   * 发送消息（记录 + 唤醒等待者）。
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
 * 经真实 AppServer 的传输层打一发 RPC 并等响应（走 AppServer 注册的真实 handler）。
 * 注意：加载 trace 会经事件桥下发 `thread.event` 通知，故等待的是**带本次 id 的响应帧**而非首帧。
 * @param transport 记录型传输（与 app 共用）
 * @param method RPC 方法名
 * @param params RPC 参数
 * @returns RPC result
 */
async function rpc(
  transport: RecordingTransport,
  method: string,
  params: Record<string, unknown>,
): Promise<TraceReadResult> {
  const id = (transport.sent.length + 1) * 1000 + Math.floor(Math.random() * 1000);
  transport.deliver({ jsonrpc: '2.0', id, method, params });
  const reply = await waitForResponse(transport, id);
  if (reply.error !== undefined) {
    throw new Error(`RPC ${method} 失败: ${reply.error.message}`);
  }
  assert.ok(reply.result !== undefined, `RPC ${method} 必须返回 result`);
  return reply.result;
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
): Promise<{ result?: TraceReadResult; error?: { message: string } }> {
  for (let i = 0; i < 400; i += 1) {
    const found = transport.sent.find(
      (message) => 'id' in message && !('method' in message) && message.id === id,
    );
    if (found !== undefined) {
      return found as { result?: TraceReadResult; error?: { message: string } };
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
  throw new Error(`RPC 响应超时（id=${String(id)}）`);
}

/** 建真实 AppServer（内存存储 + 记录型传输；存在性判定按白名单注入，内存后端无物理存档）。 */
function buildServer(
  storage: MemoryStorage,
  known: readonly string[],
): {
  app: AppServer;
  transport: RecordingTransport;
} {
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
  const app = new AppServer({
    config,
    transport,
    modelOverrideEnabled: false,
    traceSessionExists: async (sessionId) => known.includes(sessionId),
  });
  return { app, transport };
}

test('SessionEventReader：真读 .jsonl 并解析为会话事件；坏行非法 id 缺失均 fail-soft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-trace-'));
  const lines = [
    JSON.stringify(SAMPLE[0]),
    JSON.stringify(SAMPLE[1]),
    '{ 坏行不是 JSON',
    '',
    JSON.stringify(SAMPLE[2]),
  ];
  await writeFile(join(dir, 's-trace.jsonl'), lines.join('\n'), 'utf8');
  const reader = new SessionEventReader(dir);

  const events = await reader.load('s-trace');
  assert.strictEqual(events.length, 3, '坏行与空行应被跳过，不得污染事件流');
  assert.deepStrictEqual(
    events.map((e) => e.type),
    ['user', 'tool_call', 'assistant'],
  );
  assert.deepStrictEqual(await reader.load('no-such'), [], '文件缺失回空数组（不抛错）');
  assert.deepStrictEqual(await reader.load('../escape'), [], '路径穿越形态的会话 id 必须拒绝');
});

test('SessionTraceService：已加载会话返回冻结条目（新在前），并支持 kind 过滤', async () => {
  const service = new SessionTraceService({ replay: async () => SAMPLE });
  assert.strictEqual(await service.load('s-trace'), 3, 'load 应返回事件条数');

  const recent = service.read({ session: 's-trace', limit: 2 });
  assert.strictEqual(recent.count, 2);
  assert.deepStrictEqual(
    recent.entries.map((e) => e.kind),
    ['assistant', 'tool_call'],
    '新在前',
  );
  assert.ok(Object.isFrozen(recent.entries), '返回数组必须冻结');

  const onlyTool = service.read({ session: 's-trace', kind: 'tool_call' });
  assert.strictEqual(onlyTool.count, 1);
  // seq 语义：源事件流内的下标（供「按 seq 回放定位」用）。kind 过滤**不得**重编号——
  // 同一条事件在 recent 与 byKind 下必须是同一个 seq（SAMPLE[1] 即 tool_call）。
  assert.strictEqual(onlyTool.entries[0]?.seq, 1, 'byKind 的 seq 须与 recent 一致（源流下标）');
  assert.strictEqual(
    recent.entries.find((e) => e.kind === 'tool_call')?.seq,
    onlyTool.entries[0]?.seq,
    '同一事件在两种查询下的 seq 必须相同',
  );
  assert.strictEqual(onlyTool.entries[0]?.kind, 'tool_call');
});

test('SessionTraceService：未知会话 / 空 sessionId / 事件源抛错均给出 error 且不抛异常', async () => {
  const service = new SessionTraceService({ replay: async () => SAMPLE });
  const unknown = service.read({ session: 'nope' });
  assert.strictEqual(unknown.count, 0);
  assert.match(unknown.error ?? '', /未找到/);

  const empty = service.read({ session: '  ' });
  assert.match(empty.error ?? '', /sessionId/);

  const broken = new SessionTraceService({
    replay: async () => {
      throw new Error('storage blip');
    },
  });
  assert.strictEqual(await broken.load('s-trace'), 0, '事件源抛错时 load 回 0 条（fail-soft）');
  const afterBlip = broken.read({ session: 's-trace' });
  assert.strictEqual(afterBlip.count, 0);
  assert.ok(afterBlip.error !== undefined, '读取失败的会话不得被登记成「无 trace」的成功读取');
});

test('trace.read RPC：起真实 AppServer 打一发，返回该会话的冻结只读条目', async () => {
  const storage = new MemoryStorage();
  await storage.save('s-trace', SAMPLE);
  const { transport } = buildServer(storage, ['s-trace']);

  const missing = await rpc(transport, 'trace.read', { sessionId: 'no-such' });
  assert.strictEqual(missing.count, 0);
  assert.match(missing.error ?? '', /未找到/);

  const result = await rpc(transport, 'trace.read', { sessionId: 's-trace', limit: 2 });
  assert.strictEqual(result.count, 2, `应返回 2 条，实际 ${String(result.count)}`);
  assert.strictEqual(result.session, 's-trace');
  assert.deepStrictEqual(
    result.entries.map((e) => e.kind),
    ['assistant', 'tool_call'],
  );
  assert.ok(Object.isFrozen(result.entries), 'RPC 返回的条目数组必须冻结');
  assert.throws(() => {
    (result.entries[0] as { summary: string }).summary = 'tampered';
  }, /read only|read-only|Cannot assign/i);
});
