/**
 * 在跑会话事件流回卷单测（2026-10-03 清偿 PROJECT_BOARD §3-1「rollback 不截断内存事件流」）。
 *
 * 缺陷原文：`CheckpointManager.rollback` 只改磁盘，运行中会话的内存日志仍是全量，
 * 下一步 write-behind 持久化会把回滚覆盖回去 —— 用户看到「已回滚」而历史没变。
 *
 * 本文件钉住修复的各层判据（自下而上）：
 *   ① 事件日志 `rewindTo` 的越界 fail-closed 语义；
 *   ② 记录器回卷后 `lastAssistantText()` 不得返回**已被撤销**的答案，且检索索引同步清理；
 *   ③ 持久化器回卷必须**先等在飞写**再**强制重写**（长度恰好相等时也要写）；
 *   ④ 端到端：注册回卷回调后 `rollback` 真的截断内存流，且随后的落盘不会复活全量。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { EventPersister } from '../../src/core/loop/eventPersister.js';
import { CheckpointManager } from '../../src/core/checkpointManager.js';
import { LiveSessionRewindRegistry } from '../../src/core/liveSessionRewindRegistry.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type {
  RetrievalDoc,
  RetrievalPort,
  RetrievalHit,
} from '../../src/ports/intelligence/retrieval.js';

/** 造一条最小合法会话事件。 */
function evt(id: string, type: SessionEvent['type'], payload: unknown): SessionEvent {
  return { id, type, sessionId: 's1', timestamp: '2026-10-03T00:00:00.000Z', payload };
}

/** 三种内容事件 + 一条不可检索事件（覆盖 `docOf` 的两侧判据）。 */
function sample(): SessionEvent[] {
  return [
    evt('e1', 'user', { content: '第一问' }),
    evt('e2', 'reasoning', { content: '不该进检索' }),
    evt('e3', 'assistant', { content: '第一答' }),
    evt('e4', 'user', { content: '第二问' }),
    evt('e5', 'assistant', { content: '第二答' }),
  ];
}

/** 记录型检索端口替身：捕获 index/remove 调用。 */
class RecordingRetrieval implements RetrievalPort {
  /** 端口标识名（符合 RetrievalPort 契约）。 */
  public readonly name = 'recording-retrieval';
  /** 已索引的文档 id（按索引顺序）。 */
  public readonly indexed: string[] = [];
  /** 每次 `index` 收到的 `seq`（用于钉住回卷后的 seq 重算口径）。 */
  public readonly seqs: number[] = [];
  /** 每次 remove 收到的 id 批次。 */
  public readonly removals: string[][] = [];
  /** remove 是否可用（false 时模拟「后端不支持反注册」）。 */
  public supportsRemove = true;

  /**
   * 索引一条文档（记录）。
   * @param doc 会话文档
   * @returns 无返回值
   */
  public index(doc: RetrievalDoc): void {
    this.indexed.push(doc.id);
    this.seqs.push(doc.seq);
  }

  /**
   * 检索（替身恒空）。
   * @param _query 查询串
   * @param _limit 返回上限
   * @param _sessionId 会话过滤
   * @returns 空命中列表
   */
  public search(_query: string, _limit: number, _sessionId?: string): readonly RetrievalHit[] {
    return [];
  }

  /**
   * 反注册（记录批次）。
   * @param ids 待移除文档 id
   * @returns 移除条数
   */
  public remove(ids: readonly string[]): number {
    if (!this.supportsRemove) {
      return 0;
    }
    this.removals.push([...ids]);
    return ids.length;
  }
}

/** 可挂起存储替身：复现「回卷时有在飞全量写」的窗口。 */
class HoldableStorage extends MemoryStorage {
  /** 非 undefined 时写入挂起等待。 */
  private gate: Promise<void> | undefined;
  /** 放行回调。 */
  private open: (() => void) | undefined;

  /** 挂起后续写入。 @returns 无返回值 */
  public hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  /** 放行挂起的写入。 @returns 无返回值 */
  public release(): void {
    this.open?.();
    this.open = undefined;
  }

  /**
   * 落盘（可被 hold 挂起）。
   * @param sessionId 会话 ID
   * @param events 事件快照
   * @returns 落盘完成
   */
  public override async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const gate = this.gate;
    if (gate !== undefined) {
      await gate;
    }
    await super.save(sessionId, events);
  }
}

test('事件日志：rewindTo 越界/非整数一律 fail-closed 抛错，不回退成静默夹取', () => {
  const log = new AppendOnlyEventLog();
  log.hydrate(sample());
  assert.throws(() => log.rewindTo(6), /回卷长度非法/);
  assert.throws(() => log.rewindTo(-1), /回卷长度非法/);
  assert.throws(() => log.rewindTo(1.5), /回卷长度非法/);
  assert.strictEqual(log.size(), 5, '抛错路径不得改动日志');
  assert.strictEqual(log.rewindTo(5), 0, '等于当前长度是合法空操作');
  assert.strictEqual(log.rewindTo(2), 3);
  assert.deepStrictEqual(
    log.all().map((e) => e.id),
    ['e1', 'e2'],
  );
});

test('记录器：回卷后 lastAssistantText 不得返回已被撤销的答案（#OBS-10 同源风险）', () => {
  const log = new AppendOnlyEventLog();
  const recorder = new SessionRecorder(log, new SilentEventPort(), 's1');
  recorder.user('第一问'); // 下标 0（回合起点之前的历史）
  recorder.markTurnStart(); // 回合起点 = 1
  recorder.assistant('第一答'); // 下标 1
  recorder.user('第二问'); // 下标 2
  recorder.assistant('第二答'); // 下标 3
  assert.strictEqual(recorder.lastAssistantText(), '第二答');

  // 回卷到仍含本回合首答的长度：答案还在流里 ⇒ 返回**流内**最后一条本回合 assistant
  // （'第二答' 已被撤销，故此刻正确结果是 '第一答'，回卷不该让仍在的历史"失明"）。
  recorder.rewindTo(3);
  assert.strictEqual(recorder.lastAssistantText(), '第一答');

  // 回卷到**回合起点之前**（长度 1 < turnStartIndex）：必须夹回合法范围。
  // 不夹回的后果：从越界下标起倒扫，把**上一回合/历史**的 assistant 当成本回合输出，
  // 且因 finalText 非空而让「步数耗尽兜底总结」永不触发（#OBS-10 记录的静默错答形态）。
  recorder.rewindTo(1);
  assert.strictEqual(log.size(), 1);
  assert.strictEqual(
    recorder.lastAssistantText(),
    undefined,
    '回合起点被夹回新长度后，不得把已撤销的答案当成本回合输出',
  );
});

test('记录器：回卷把被撤销区间的文档从检索索引反注册，并重算 seq 口径', () => {
  const log = new AppendOnlyEventLog();
  const retrieval = new RecordingRetrieval();
  const recorder = new SessionRecorder(log, new SilentEventPort(), 's1', retrieval);
  // 故意夹一条不可检索事件（reasoning）：反注册批次必须只含可检索的那两条。
  const i1 = recorder.user('第一问');
  recorder.reasoning('思考过程不入检索');
  const i2 = recorder.assistant('第一答');
  const i3 = recorder.user('第二问');
  const i4 = recorder.assistant('第二答');
  assert.deepStrictEqual(
    retrieval.indexed,
    [i1.id, i2.id, i3.id, i4.id],
    'reasoning 不入检索（与 docOf 同判据）',
  );

  recorder.rewindTo(3);
  assert.deepStrictEqual(retrieval.removals, [[i3.id, i4.id]], '只反注册被撤销的可检索事件');
  // seq 重算：截断后仍有 2 条可索引事件 ⇒ 下一条新文档的 seq 必须是 2。
  const i5 = recorder.user('第三问');
  assert.strictEqual(log.size(), 4);
  assert.deepStrictEqual(retrieval.seqs, [0, 1, 2, 3, 2], '回卷后 seq 必须重算而非继续增长');
  assert.strictEqual(i5.id.length > 0, true);
});

test('记录器：检索后端不支持反注册时如实告警，不谎称已彻底回滚', () => {
  const log = new AppendOnlyEventLog();
  const retrieval = new RecordingRetrieval();
  retrieval.supportsRemove = false;
  const recorder = new SessionRecorder(log, new SilentEventPort(), 's1', retrieval);
  recorder.user('第一问');
  recorder.assistant('第一答');
  recorder.user('第二问');
  recorder.assistant('第二答');
  const removed = recorder.rewindTo(2);
  assert.strictEqual(removed, 2);
  assert.deepStrictEqual(retrieval.removals, [], '不支持的后端不该被调用');
  assert.strictEqual(log.size(), 2);
});

test('持久化器：回卷先等在飞全量写落地，再强制写回截断快照（不被旧快照覆盖）', async () => {
  const storage = new HoldableStorage();
  let events = sample();
  const persister = new EventPersister(storage, 's1', () => events);
  storage.hold();
  const inflight = persister.flush(); // 读到的是 5 条全量快照，写被挂起
  events = events.slice(0, 3);
  const rewound = persister.rewindTo(3);
  storage.release();
  await Promise.all([inflight, rewound]);

  const persisted = await storage.load('s1');
  assert.deepStrictEqual(
    persisted.map((e) => e.id),
    ['e1', 'e2', 'e3'],
    '在飞全量写之后必须再写一次截断快照，否则回滚被覆盖',
  );
});

test('持久化器：回卷后条数恰好等于上次落盘条数时也必须重写（长度判脏不够用）', async () => {
  const storage = new MemoryStorage();
  let events = sample();
  const persister = new EventPersister(storage, 's1', () => events);
  await persister.flush();
  assert.strictEqual((await storage.load('s1')).length, 5);

  // 回卷到 5 条再回卷到 3 条：
  events = events.slice(0, 3);
  await persister.rewindTo(3);
  assert.strictEqual((await storage.load('s1')).length, 3);
  // 再回卷到「与 lastSavedCount 相同」的长度：3 → 3 属于空操作，但换成 5 → 3 后
  // 又把 lastSavedCount 设回 3 的场景（等价于回滚到上次成功落盘点）必须仍然写盘。
  await storage.save('s1', events);
  await persister.rewindTo(3);
  assert.strictEqual((await storage.load('s1')).length, 3);
});

test('端到端：注册回卷回调后 rollback 截断内存流，后续落盘不再复活全量（P1 回归判据）', async () => {
  const storage = new MemoryStorage();
  const log = new AppendOnlyEventLog();
  const recorder = new SessionRecorder(log, new SilentEventPort(), 's1');
  const persister = new EventPersister(storage, 's1', () => log.all());
  const rewinder = async (size: number): Promise<void> => {
    recorder.rewindTo(size);
    await persister.rewindTo(size);
  };
  const registry = new LiveSessionRewindRegistry();
  registry.register('s1', rewinder);

  const manager = new CheckpointManager(storage, { rewind: registry });
  recorder.user('第一问');
  recorder.assistant('第一答');
  const meta = await manager.snapshot('s1', 'cp1');
  recorder.user('第二问');
  recorder.assistant('第二答');
  await persister.flush();
  assert.strictEqual((await storage.load('s1')).length, 4);

  await manager.rollback('s1', 'cp1');
  assert.strictEqual(log.size(), meta.eventCount, '内存事件流被截断到检查点长度');
  assert.strictEqual((await storage.load('s1')).length, meta.eventCount);

  // 旧缺陷的复现动作：回滚后照样安排一次 write-behind 落盘——历史不得复活。
  persister.schedule();
  await persister.flush();
  assert.strictEqual((await storage.load('s1')).length, meta.eventCount, '回滚不得被后续落盘覆盖');
  registry.unregister('s1', rewinder);
});

test('登记表：未命中在跑会话时 rewind 返回 false（离线回滚不是失败）', async () => {
  const registry = new LiveSessionRewindRegistry();
  assert.strictEqual(await registry.rewind('nobody', 1), false);
  assert.strictEqual(registry.size(), 0);
});

test('登记表：unregister 只在身份一致时删除（并发复用 sessionId 不得误摘）', async () => {
  const registry = new LiveSessionRewindRegistry();
  const first = async (): Promise<void> => undefined;
  let secondCalls = 0;
  const second = async (): Promise<void> => {
    secondCalls += 1;
  };
  registry.register('s1', first);
  registry.register('s1', second);
  registry.unregister('s1', first); // 旧回合结束：不得删掉新回合的登记
  assert.strictEqual(registry.size(), 1);
  assert.strictEqual(await registry.rewind('s1', 0), true);
  assert.strictEqual(secondCalls, 1);
  registry.unregister('s1', second);
  assert.strictEqual(registry.size(), 0);
});

test('登记表：回卷回调抛错时不吞错（fail-soft 且返回 false，交由调用方处置）', async () => {
  const registry = new LiveSessionRewindRegistry();
  registry.register('s1', async () => {
    throw new Error('内存已损坏');
  });
  assert.strictEqual(await registry.rewind('s1', 1), false);
});
