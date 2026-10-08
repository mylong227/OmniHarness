/**
 * serve 侧**图运行存档**的判据（2026-10-08）。
 *
 * 被钉住的声明：serve 发起的图运行（`graph.run`）同样落盘到
 * `<workspace>/.omniharness/graph-runs/<runId>.jsonl`，且**存档 id 就是 `graph.run` 返回的台账
 * runId**——这样通知/`graph.status` 里的 id 与「可续跑的 runId」是同一个，用户不必在两套 id 之间对照。
 *
 * 为什么必须单独钉一遍：这条接线（`appServer.startGraphRun` 的 `persist: true` + `runId`）是
 * 另一笔提交留下的两行，落地时**没有任何 serve 侧判据**（既有 `workflowRunLog`/`workflowControlledRun`
 * 测的是 runner 本身，`workflowRunnerLimits` 测的是并发，都不经过 RPC 装配）。本仓的缺陷家族里
 * 「声明了但没接线」占大头，故补这条端到端判据：RPC → 真图运行 → 真文件 → 读回可续跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      await sleep(5);
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
 * @param timeoutMs 上限
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

test('graph.run：图运行落盘且存档 id = 台账 runId，读回即可续跑', async () => {
  const workspaceRoot = tempWorkspace();
  const transport = new TestTransport();
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

  const def: WorkflowDef = {
    name: 'persist-probe',
    steps: [{ id: 's1', prompt: '打个招呼', tools: ['shell'] }],
  };
  const response = (await transport.receive('graph.run', { def }, 1)) as {
    result: { runId: string; nodeCount: number };
  };
  assert.strictEqual(response.result.nodeCount, 1, 'graph.run 应回报节点数');
  const runId = response.result.runId;
  assert.ok(runId.length > 0, 'graph.run 必须回报 runId');

  const done = (await waitFor(() => transport.notifications('graph.done')[0])) as unknown as {
    params: { runId: string; ok: boolean };
  };
  assert.strictEqual(done.params.runId, runId);
  assert.strictEqual(
    done.params.ok,
    true,
    '图应跑成功（MockModel + auto 审批 + passthrough 沙箱）',
  );

  const file = join(workspaceRoot, '.omniharness', 'graph-runs', `${runId}.jsonl`);
  assert.ok(existsSync(file), `serve 发起的图运行必须落盘：${file}`);
  const lines = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { t: string; runId?: string });
  assert.strictEqual(lines[0]?.t, 'run.start', '首行必须是自描述的 run.start');
  assert.strictEqual(lines[0]?.runId, runId, '存档 id 必须等于台账 runId（两套 id 不许分叉）');
  assert.strictEqual(lines.at(-1)?.t, 'run.end', '收尾必须写下 run.end');

  // 可续跑的判据：同一 runId 能读回规格与步骤状态（续跑入口在 CLI / 模型工具，见看板诚实边界）。
  const replay = new WorkflowRunLog(workspaceRoot).read(runId);
  assert.strictEqual(replay.header.runId, runId);
  assert.strictEqual(replay.ended, true, '已结束的运行应可读回 run.end');
  assert.ok(replay.statuses.has('s1'), '步骤终态必须落盘（续跑只复用 done）');
});
