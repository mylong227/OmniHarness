/**
 * 并发回合的**取消隔离**回归（2026-09-22，审计 P1）。
 *
 * 被修的缺陷：`Agent` 原先把取消令牌与增量持久化器存成**单字段**（`currentCancel` / `currentPersister`），
 * 每个新回合覆盖写、`finally` 置空；而服务端允许多回合并行（`appServer` 的 `activeTurns` 是 Set）⇒
 * ① 先结束的回合清空令牌，「停止」按钮**静默失效**；② 取消的是**后启动的会话**（停 A 实际停 B）。
 *
 * 本测试用「不真正挂起就永远不返回」的模型（模拟在飞 fetch：abort → reject）钉住三点：
 * ① 按 sessionId 取消只影响目标会话，另一会话**仍在跑**；
 * ② 不带 sessionId 时（旧行为 / CLI 单会话）取消全部在跑会话；
 * ③ 会话收尾后登记被清理（无泄漏），且取消一个不存在的会话是 no-op。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 等待上限（毫秒）。刻意给得宽松：`npm test`（CI 口径）**并行**跑全部单测文件，
 * 实测同一用例在并行负载下从 0.1s 涨到 8s+ ⇒ 按「空闲机器」给紧凑超时会变 flaky
 * （首次并行跑即踩到：初始等待在 5s 上限下失败）。
 */
const WAIT_START_MS = 30_000;
/** 取消后收尾的等待上限（毫秒）。 */
const WAIT_SETTLE_MS = 15_000;
/** 「误伤窗口」：给错误地「连带取消」留出暴露时间（abort 是同步兑现的，百余毫秒足够）。 */
const MISFIRE_WINDOW_MS = 150;

/** 轮询等待谓词成立（最多 timeoutMs）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/** 在飞即挂起的模型：abort 信号触发即 reject（与真实 fetch 语义一致）。 */
class HangingModel implements ModelPort {
  /** 端口名（模型适配器标识）。 */
  public readonly name = 'hanging';
  /** 收到的模型请求数（用于确认会话确实进入了在飞模型调用）。 */
  public started = 0;
  /** 被 abort 的次数（用于确认取消确实打在模型请求上）。 */
  public aborted = 0;

  /**
   * 在飞即挂起：**只有 abort 信号能使其收尾**（模拟真实 fetch：signal abort → 请求 reject）。
   * @param request 模型请求（从中读取取消信号）
   * @returns 永不 resolve 的 Promise（仅在被 abort 时 reject）
   */
  public generate(request: ModelRequest): Promise<ModelOutput> {
    this.started += 1;
    return new Promise<ModelOutput>((resolve, reject) => {
      const signal = request.signal;
      if (signal === undefined) {
        reject(new Error('测试模型要求注入 signal'));
        return;
      }
      if (signal.aborted) {
        this.aborted += 1;
        reject(new Error('已中止'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          this.aborted += 1;
          reject(new Error('已中止（模拟 fetch abort）'));
        },
        { once: true },
      );
      // 永不 resolve：只有 abort 才能让它收尾（模拟长耗时在飞请求）
      void resolve;
    });
  }
}

/** 构造 Agent（内存存储 + 静默事件端口 + 自动审批 + 直通沙箱）。 */
function buildAgent(model: ModelPort): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model,
    storage: new MemoryStorage(),
    events: new SilentEventPort(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    spillAdapter: 'memory',
  });
  return new Agent(createRuntime(config));
}

/** 追踪 promise 是否已 settle（不关心成功/失败）。 */
function tracker(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

test('① 按 sessionId 取消只停目标会话，另一并发会话仍在跑', async () => {
  const model = new HangingModel();
  const agent = buildAgent(model);
  const runA = agent.runTask('会话 A');
  const runB = agent.runTask('会话 B');
  const settledA = tracker(runA);
  const settledB = tracker(runB);

  assert.ok(
    await waitFor(
      () => agent.runningSessionIds().length === 2 && model.started === 2,
      WAIT_START_MS,
    ),
    '两个会话都应登记在跑并已发出模型请求',
  );
  const [idA, idB] = agent.runningSessionIds();
  assert.ok(idA !== undefined && idB !== undefined);

  agent.cancelCurrentRun('user', idA);
  assert.ok(await waitFor(() => settledA(), WAIT_SETTLE_MS), '目标会话应被取消并收尾');
  await sleep(MISFIRE_WINDOW_MS); // 给「误伤」留出暴露窗口
  assert.strictEqual(settledB(), false, '另一会话**不得**被连带取消（旧实现会误停它）');
  assert.deepStrictEqual(agent.runningSessionIds(), [idB], '被取消会话的登记应已清理');

  agent.cancelCurrentRun('user', idB);
  assert.ok(await waitFor(() => settledB(), WAIT_SETTLE_MS), '第二个会话也应能按 id 取消');
  await runA.catch(() => undefined);
  await runB.catch(() => undefined);
  assert.strictEqual(agent.runningSessionIds().length, 0, '全部收尾后无残留登记');
});

test('② 不带 sessionId 时取消全部在跑会话（CLI 单会话语义 / 旧前端兼容）', async () => {
  const model = new HangingModel();
  const agent = buildAgent(model);
  const runA = agent.runTask('会话 A');
  const runB = agent.runTask('会话 B');
  const settledA = tracker(runA);
  const settledB = tracker(runB);
  assert.ok(await waitFor(() => agent.runningSessionIds().length === 2, WAIT_START_MS));

  agent.cancelCurrentRun('user');
  assert.ok(await waitFor(() => settledA() && settledB(), WAIT_SETTLE_MS), '两会话都应被取消');
  await runA.catch(() => undefined);
  await runB.catch(() => undefined);
  assert.strictEqual(agent.runningSessionIds().length, 0);
});

test('③ 取消不存在的会话是 no-op（不抛错、不影响在跑会话）', async () => {
  const model = new HangingModel();
  const agent = buildAgent(model);
  const run = agent.runTask('唯一会话');
  const settled = tracker(run);
  assert.ok(await waitFor(() => agent.runningSessionIds().length === 1, WAIT_START_MS));
  const id = agent.runningSessionIds()[0] ?? '';

  agent.cancelCurrentRun('user', 'sess_不存在');
  await sleep(50);
  assert.strictEqual(settled(), false, '取消未知会话不得误伤在跑会话');

  agent.cancelCurrentRun('user', id);
  assert.ok(await waitFor(() => settled(), WAIT_SETTLE_MS));
  await run.catch(() => undefined);
});
