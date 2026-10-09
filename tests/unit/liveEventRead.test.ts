/**
 * 「只读查询必须真·纯读，而且必须读到**实时**事件」的判据（2026-10-09）。
 *
 * ## 被改的形态（真机证据）
 *
 * 容量面板在**回合进行中**打开时显示 `0/12.8万`、缓存命中显示 `—`（真机采样：t≈0.8s 与 1.6s
 * 两次都是全零，回合结束后才跳出真实数字）。根因是 `context.usage` 这条**只读**查询接在
 * `Agent.replay` 上，而 `replay`：
 *   ① 读 `storage.load`（write-behind：`TurnRunner` **每步**才 `schedule()` 一次 ⇒ 第一步模型调用
 *      还没返回时**盘上从来没有被写过**）⇒ 面板拿到 `source:'empty'` 的全零报告；
 *   ② 把**整段历史重新广播**到事件总线 —— 而面板在忙时每 2s 调一次（正对照实测：每次调用都在
 *      /events 上多出重播事件）。
 *
 * 修法：新增 `Agent.eventsOf`（在跑会话取内存事实源、其余取存档，**零广播**），只读消费者改接它；
 * `replay` 保留给"客户端要通过事件流重建视图"的路径。
 *
 * ## 判据
 *
 * | # | 判据 | 旧实现下的表现 |
 * |---|------|----------------|
 * | ① | 回合停在第一步模型调用里时，盘上为空（**前提**，也是面板显示 0 的那个窗口） | 同（这是成因） |
 * | ② | 此刻 `eventsOf` 仍能读到内存事实源的真实事件 | **红**：旧 `replay` 读盘 ⇒ 空数组 |
 * | ③ | `eventsOf` 不写事件总线（纯读） | **红**：旧 `replay` 每调一次就重播整段历史 |
 * | ④ | 正对照：`replay` 仍逐条广播同一份事件（判据不是"把广播删了"） | 绿（保功能） |
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';

/** 记录型事件端口：数被广播过的事件条数（判"有没有写总线"）。 */
class RecordingEventPort implements EventPort {
  /** 适配器名（端口契约要求）。 */
  public readonly name = 'recording';
  /** 收到的全部事件（按广播序）。 */
  public readonly seen: SessionEvent[] = [];

  /**
   * 记录一次广播。
   * @param event 会话事件
   * @returns 无返回值
   */
  public emit(event: SessionEvent): void {
    this.seen.push(event);
  }

  /**
   * 已广播条数。
   * @returns 条数
   */
  public count(): number {
    return this.seen.length;
  }
}

/**
 * 首次 `generate` 会**挂起**到测试放行的模型桩：用来把回合精确停在「第一步模型调用里」——
 * 那正是盘上还没被调度写过的窗口。
 */
class GatedMockModel implements ModelPort {
  /** 适配器名（与端口契约一致）。 */
  public readonly name = 'mock';
  /** 首次 generate 已进入（测试据此确定"回合确实在跑"）。 */
  public readonly entered: Promise<void>;
  /** 放行闸门。 */
  private readonly gate: Promise<void>;
  /** entered 的 resolve。 */
  private markEntered: () => void = () => {};
  /** gate 的 resolve。 */
  private releaseGate: () => void = () => {};
  /** generate 被调用次数。 */
  private calls = 0;

  public constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.markEntered = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  /** 放行首次调用（回合继续跑完）。
   * @returns 无返回值
   */
  public open(): void {
    this.releaseGate();
  }

  /**
   * 生成响应：首次先挂起（等 `open()`），之后直接给最终文本。
   * @param _request 模型请求（本桩不使用）
   * @returns 模型输出
   */
  public async generate(_request: ModelRequest): Promise<ModelOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      this.markEntered();
      await this.gate;
    }
    return { text: '完成（桩模型）' };
  }
}

test('只读事件读取：在跑会话读内存事实源，且纯读不广播（replay 仍广播作正对照）', async () => {
  const storage = new MemoryStorage();
  const port = new RecordingEventPort();
  const model = new GatedMockModel();
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 8,
    model,
    storage,
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: port,
  });
  const agent = new Agent(Runtime.createRuntime(config));

  const task = agent.runTask('实时读取判据');
  await model.entered;

  const sessionId = agent.runningSessionIds()[0];
  assert.ok(
    sessionId !== undefined && sessionId !== '',
    '模型已进入首次 generate ⇒ 必须有一个在跑会话（否则本判据不成立）',
  );

  // ① 前提：write-behind 是「每步 schedule」，第一步模型调用尚未返回 ⇒ 盘上从未被写过。
  const onDisk = await storage.load(sessionId);
  assert.deepStrictEqual(
    onDisk,
    [],
    '（前提）回合停在第一步模型调用里时盘上必须为空 —— 这正是容量面板显示 0/… 的窗口',
  );

  // ② 内存事实源此刻已经有真实事件 ⇒ 只读查询必须能拿到它。
  const live = await agent.eventsOf(sessionId);
  assert.ok(
    live.length > 0,
    'eventsOf 必须读到内存事实源：盘上为空时也要能给出真实事件（旧实现读盘 ⇒ 空数组 ⇒ 面板全零）',
  );
  assert.ok(
    live.some((e) => e.type === 'user'),
    '刚写入的用户消息事件必须在其中',
  );

  // ③ 纯读：不得写事件总线。
  const beforeRead = port.count();
  await agent.eventsOf(sessionId);
  assert.strictEqual(
    port.count(),
    beforeRead,
    'eventsOf 是纯读入口：不得广播任何事件（旧实现每调一次就重播整段历史）',
  );

  model.open();
  const done = await task;
  assert.strictEqual(done.sessionId, sessionId, '会话 id 应与在跑时观察到的一致');

  // ④ 正对照：`replay` 仍负责"把历史广播给客户端"，不能被顺手删掉（两个入口分工不同）。
  const persisted = await storage.load(sessionId);
  assert.ok(persisted.length > 0, '回合结束后盘上必须有事件');
  const beforeReplay = port.count();
  const replayed = await agent.replay(sessionId);
  assert.strictEqual(replayed.length, persisted.length, 'replay 必须返回存档全量');
  assert.strictEqual(
    port.count() - beforeReplay,
    persisted.length,
    'replay 必须仍逐条广播（判据不是"把广播删了"）',
  );
});
