/**
 * A2A 委托工具单测（U6 收口：发起委托的工具面）。
 *
 * 判据结构：
 * - **契约面**：task 自包含校验（空参拒绝且**不发请求**）、taskId/parentSessionId 传递、
 *   tools 授权子集透传、对端结果转述（ok 与失败原因都要可见——ContextAssembler 只渲染
 *   ok=false 的 error，把原因塞进 output 等于丢掉）；
 * - **注册面**：a2a.enabled 时 createRuntime 后工具表必须出现 `a2a_delegate`（此前 client
 *   装配进 runtime.a2a 后零调用点——「半边能力」的收口判据）。
 *
 * 仪器：假传输实现 `A2aTransport` 端口（不发真网络包），按 method 回 canned JSON-RPC 响应。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2aDelegateTool } from '../../src/a2a/a2aDelegateTool.js';
import { A2aClient } from '../../src/a2a/a2aClient.js';
import { A2A_TASK_DELEGATE } from '../../src/a2a/a2aProtocol.js';
import type { A2aTransport } from '../../src/ports/a2a/a2aTransport.js';
import type { RpcMessage } from '../../src/ports/server/rpcMessage.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

/** 假对端：捕获发送的请求，按 method 回 canned 响应（经 onMessage 回注）。 */
class FakePeerTransport implements A2aTransport {
  /** 已发出的请求（断言 tools/taskId/parentSessionId 透传用）。 */
  public readonly sent: RpcMessage[] = [];
  /** 下一次 task.delegate 请求的应答（undefined = 不应答）。 */
  public delegateResponse:
    | {
        readonly result?: unknown;
        readonly error?: { readonly code: number; readonly message: string };
      }
    | undefined;
  /** 入站回调（构造后由 `A2aClient.onMessage` 注册）。 */
  private respond: ((message: RpcMessage) => void) | undefined;

  /**
   * 捕获发出的消息，并对配置了应答的 task.delegate 请求回 canned JSON-RPC 响应。
   * @param message 出站 JSON-RPC 消息。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    this.sent.push(message);
    if (this.delegateResponse === undefined) return;
    if (!('id' in message) || message.id === undefined) return;
    const id = message.id;
    const response = this.delegateResponse;
    this.respond?.({
      jsonrpc: '2.0',
      id,
      ...(response.error !== undefined ? { error: response.error } : { result: response.result }),
    } as RpcMessage);
  }

  /**
   * 注册入站回调（`A2aTransport` 端口契约）。
   * @param callback 入站消息回调。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.respond = callback;
  }

  /**
   * 取最近一条 task.delegate 请求的 params（透传断言用）。
   * @returns 请求参数记录；无请求时断言失败。
   */
  public lastDelegateParams(): Record<string, unknown> {
    const last = this.sent.at(-1) as
      { method?: string; params?: Record<string, unknown> } | undefined;
    assert.ok(
      last !== undefined && last.method === A2A_TASK_DELEGATE,
      '最近一条请求应为 task.delegate',
    );
    return last.params ?? {};
  }
}

/** 最小工具上下文。 */
function ctx(): ToolContext {
  return { sessionId: 'sess-1', workspaceRoot: join(tmpdir(), 'omni-a2a-tool-') };
}

/** 最小调用（call.id 由端口生成，测试里手写固定值）。 */
function call(args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', name: 'a2a_delegate', arguments: args } as ToolCall;
}

test('成功路径：委托请求带 taskId/parentSessionId，结果转述含对端输出', async () => {
  const transport = new FakePeerTransport();
  transport.delegateResponse = {
    result: { ok: true, output: '对端干完了', steps: 3, durationMs: 1234 },
  };
  const tool = new A2aDelegateTool(new A2aClient(transport));
  const r = await tool.handle(call({ task: '帮我跑一遍单测' }), ctx());
  assert.strictEqual(r.ok, true);
  assert.match(r.output ?? '', /对端干完了/);
  assert.match(r.output ?? '', /steps=3/);
  const params = transport.lastDelegateParams();
  assert.strictEqual(params['task'], '帮我跑一遍单测');
  assert.strictEqual(params['parentSessionId'], 'sess-1');
  const taskId = params['taskId'];
  assert.ok(typeof taskId === 'string' && taskId.startsWith('a2a-'), `taskId=${String(taskId)}`);
});

test('失败路径：对端 ok=false / JSON-RPC error / 空任务（不发请求）', async () => {
  const ctxv = ctx();
  // ① 对端执行失败：原因必须进 error（ok=false 时 ContextAssembler 只渲染 error）。
  const failTransport = new FakePeerTransport();
  failTransport.delegateResponse = {
    result: { ok: false, output: '', steps: 1, durationMs: 5, error: '工具越权' },
  };
  const failTool = new A2aDelegateTool(new A2aClient(failTransport));
  const failResult = await failTool.handle(call({ task: 'x' }), ctxv);
  assert.strictEqual(failResult.ok, false);
  assert.match(failResult.error ?? '', /工具越权/);
  // ② JSON-RPC 层错误（验签失败/未知方法等）：转可读错误。
  const rpcErrorTransport = new FakePeerTransport();
  rpcErrorTransport.delegateResponse = { error: { code: -32001, message: 'unauthorized' } };
  const rpcErrorTool = new A2aDelegateTool(new A2aClient(rpcErrorTransport));
  const rpcErrorResult = await rpcErrorTool.handle(call({ task: 'x' }), ctxv);
  assert.strictEqual(rpcErrorResult.ok, false);
  assert.match(rpcErrorResult.error ?? '', /unauthorized/);
  // ③ 空任务：直接拒绝，且**不发任何请求**（对端不该收到垃圾委托）。
  const noSendTransport = new FakePeerTransport();
  const noSendTool = new A2aDelegateTool(new A2aClient(noSendTransport));
  const emptyResult = await noSendTool.handle(call({ task: '   ' }), ctxv);
  assert.strictEqual(emptyResult.ok, false);
  assert.match(emptyResult.error ?? '', /自包含/);
  assert.strictEqual(noSendTransport.sent.length, 0, '空任务不得发出委托请求');
});

test('tools 授权子集透传（对端按交集 fail-closed 执行）', async () => {
  const transport = new FakePeerTransport();
  transport.delegateResponse = { result: { ok: true, output: 'done', steps: 1, durationMs: 2 } };
  const tool = new A2aDelegateTool(new A2aClient(transport));
  await tool.handle(call({ task: 'x', tools: ['shell', 'reader', 42] }), ctx());
  const params = transport.lastDelegateParams();
  assert.deepStrictEqual(params['tools'], ['shell', 'reader'], '非字符串成员必须被剔除');
});

test('注册面：a2a.enabled 时 createRuntime 后工具表出现 a2a_delegate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-a2a-reg-'));
  const config = ConfigFactory.build({
    workspaceRoot: dir,
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    a2a: { enabled: true, port: 0 },
  });
  const runtime = Runtime.createRuntime(config);
  try {
    const names = config.tools.list().map((t) => t.name);
    assert.ok(names.includes('a2a_delegate'), `工具表缺 a2a_delegate：${JSON.stringify(names)}`);
    assert.ok(runtime.a2a !== undefined, 'runtime.a2a 应已装配');
  } finally {
    runtime.a2a?.transport.close?.();
  }
});
