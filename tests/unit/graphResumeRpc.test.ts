/**
 * `graph.resume` RPC 的端到端判据（2026-10-08）。
 *
 * ## 为什么必须有这条
 *
 * `graph.run` 在 serve 侧**只写**运行存档（`appServer.startGraphRun` 的 `persist: true` + `runId`），
 * 而「读回存档 → 重跑未完成步骤」这条恢复入口此前只在 CLI（`workflow --resume-run`）与模型工具
 * （`run_workflow({resume})`）存在 ⇒ Web 端发起的图跑坏了就没法续（看板 §10.3 登记的诚实边界）。
 * 本判据把 RPC 这条缝钉死：**规格来自存档首行**、中断步骤重跑、`attempt` 递增、台账 id 与存档 id 一致。
 *
 * 判据用「手工造一份只写了 step.start 的存档」模拟崩溃现场（真崩进程在单测里不可控），
 * 然后走真实 RPC → 真 `WorkflowRunner.resume` → 真文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServer } from '../../src/server/core/appServer.js';
import { type RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { WorkflowRunLog } from '../../src/autonomy/workflowRunLog.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';
import type { WorkflowDef } from '../../src/autonomy/workflowTypes.js';

/** 轮询间隔（毫秒）。 */
const POLL_MS = 5;

/** 等一等的实现（显式声明返回类型，便于门禁统计 @returns 覆盖）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 可编程传输（测试双端）。 */
class TestTransport implements Transport {
  /** 已下发的消息。 */
  public readonly sent: RpcMessage[] = [];

  /** 入站回调（由被测 AppServer 注册）。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /**
   * 记录一条下行消息。
   * @param message RPC 消息
   * @returns 无返回值
   */
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }

  /**
   * 入站订阅。
   * @param callback 入站回调
   * @returns 无返回值
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 模拟客户端发送请求（轮询等响应，容忍异步 handle）。
   * @param method 方法名
   * @param params 参数
   * @param id 请求 id
   * @returns 响应消息
   */
  public async receive(
    method: string,
    params: Record<string, unknown>,
    id = 1,
  ): Promise<RpcMessage> {
    await this.callback?.({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = this.sent.find((message) => 'id' in message && message.id === id);
      if (response !== undefined) return response;
      await sleep(POLL_MS);
    }
    return { jsonrpc: '2.0', id, result: undefined };
  }

  /**
   * 已发送的指定方法通知。
   * @param method 通知方法名
   * @returns 命中消息
   */
  public notifications(method: string): RpcMessage[] {
    return this.sent.filter((message) => 'method' in message && message.method === method);
  }
}

/**
 * 轮询等待条件成立。
 * @param probe 取值函数（未就绪返回 undefined）
 * @param timeoutMs 上限（毫秒）
 * @returns 命中的值
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = probe();
    if (hit !== undefined) return hit;
    await sleep(10);
  }
  throw new Error('等待条件超时');
}

/** 单步图定义（步骤 id 固定为 s1，便于断言存档内容）。 */
const DEF: WorkflowDef = { name: 'resume-probe', steps: [{ id: 's1', prompt: '打个招呼' }] };

/**
 * 造一个 AppServer（mock 模型 + 静默事件 + auto 审批 + passthrough 沙箱，离线可跑）。
 * @param workspaceRoot 工作区根
 * @param transport 测试传输
 * @returns 无返回值（AppServer 自行注册 handler）
 */
function mountServer(workspaceRoot: string, transport: TestTransport): void {
  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  new AppServer({ config, transport, modelOverrideEnabled: false });
}

test('graph.resume：中断步骤重跑、attempt 递增、规格取自存档首行', async () => {
  const workspaceRoot = tempWorkspace();
  const transport = new TestTransport();
  mountServer(workspaceRoot, transport);

  // 手工造「崩溃现场」：存档有 run.start 与 s1 的 step.start，但没有 step.end。
  const log = new WorkflowRunLog(workspaceRoot);
  const runId = 'run_manual_resume_1';
  log.create(DEF, runId, 1);
  log.appendStepStart(runId, 's1', 1);

  const response = (await transport.receive('graph.resume', { runId }, 1)) as {
    result?: { runId: string; nodeCount: number };
    error?: { message: string };
  };
  assert.ok(
    response.result !== undefined,
    `graph.resume 应成功返回，实际响应：${JSON.stringify(response)}`,
  );
  assert.strictEqual(response.result.runId, runId, '续跑必须沿用同一个 runId（台账 id = 存档 id）');
  assert.strictEqual(response.result.nodeCount, 1, '节点数取自存档里的规格');

  const done = (await waitFor(() => transport.notifications('graph.done')[0])) as unknown as {
    params: { runId: string; ok: boolean };
  };
  assert.strictEqual(done.params.runId, runId);
  assert.strictEqual(done.params.ok, true, 'mock 模型下续跑应成功');

  const file = join(workspaceRoot, '.omniharness', 'graph-runs', `${runId}.jsonl`);
  const lines = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) => JSON.parse(line) as { t: string; id?: string; status?: string; attempt?: number },
    );
  assert.strictEqual(
    lines.filter((line) => line.t === 'run.start').length,
    1,
    '续跑不得新写一份 run.start（否则会把两次运行折叠成一次）',
  );
  const rerun = lines.filter((line) => line.t === 'step.end' && line.id === 's1');
  assert.strictEqual(rerun.length, 1, '中断的 s1 应被重跑并写下终态');
  assert.strictEqual(rerun[0]?.status, 'done');
  assert.strictEqual(rerun[0]?.attempt, 2, '重跑记为第 2 次尝试（attempt 从存档读回后递增）');
});

test('graph.resume：runId 缺失 / 不存在 ⇒ fail-closed 报错（不新建一次「看着像续跑」的运行）', async () => {
  const workspaceRoot = tempWorkspace();
  const transport = new TestTransport();
  mountServer(workspaceRoot, transport);

  const missing = (await transport.receive('graph.resume', {}, 1)) as {
    error?: { message: string };
  };
  assert.match(missing.error?.message ?? '', /graph\.resume 需要 runId/);

  const unknown = (await transport.receive('graph.resume', { runId: 'run_nope_1' }, 2)) as {
    error?: { message: string };
  };
  assert.match(unknown.error?.message ?? '', /找不到运行日志/);
});
