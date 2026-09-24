import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventPersister } from '../../src/core/loop/eventPersister.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { StoragePort } from '../../src/ports/memory/storage.js';

/** 造一条最小合法会话事件。 */
function evt(id: string): SessionEvent {
  return {
    id,
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-09-24T00:00:00.000Z',
    payload: {},
  };
}

/** 可编程存储替身：记录每次落盘快照，并可按需让写入「挂起」以复现并发窗口。 */
class RecordingStorage implements StoragePort {
  /** 端口标识名（诊断用，符合 StoragePort 契约）。 */
  public readonly name = 'recording';
  /** 每次 save 收到的事件 id 序列。 */
  public readonly writes: string[][] = [];
  /** 当前写入闸门（非 undefined 时 save 会挂起等待）。 */
  private gate: Promise<void> | undefined;
  /** 放行闸门的回调（release() 调用）。 */
  private openGate: (() => void) | undefined;
  /** 让 save 失败（验证 fail-soft）。 */
  public failNext = false;

  /**
   * 挂起后续写入，直到 {@link RecordingStorage.release}。
   * @returns 无返回值。
   */
  public hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  /**
   * 放行被 hold() 挂起的写入。
   * @returns 无返回值。
   */
  public release(): void {
    this.openGate?.();
    this.openGate = undefined;
  }

  /**
   * 记录一次落盘（可被 hold() 挂起、可被 failNext 置为失败）。
   * @param _sessionId 会话标识（替身不区分）。
   * @param events 本次落盘的事件快照。
   * @returns 落盘完成（或按开关挂起/抛错）。
   */
  public async save(_sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const gate = this.gate;
    if (gate !== undefined) {
      await gate;
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error('磁盘满了');
    }
    this.writes.push(events.map((e) => e.id));
  }

  /**
   * 读回历史（替身恒为空）。
   * @returns 空数组。
   */
  public async load(): Promise<readonly SessionEvent[]> {
    return [];
  }
}

test('EventPersister: 在飞写入期间的 flush **不被丢弃**（审计 §1.7 回归）', async () => {
  const storage = new RecordingStorage();
  const events: SessionEvent[] = [evt('a')];
  const persister = new EventPersister(storage, 's1', () => [...events], { batchDelayMs: 0 });

  storage.hold();
  const first = persister.flush(); // 在飞（挂起）
  // 让第一次真的开始：读快照 → 进入 save 并挂起在 gate 上。否则下面 push 的事件会被第一次一起写掉，
  // 就复现不出「在飞期间的新事件」这个窗口了。
  await new Promise((r) => setImmediate(r));
  events.push(evt('b'));
  const second = persister.flush(); // 原实现：flushing 为真 ⇒ 直接 return，这次请求丢失
  storage.release();
  await Promise.all([first, second]);

  assert.deepStrictEqual(
    storage.writes,
    [['a'], ['a', 'b']],
    '第二次 flush 必须真的落盘（新事件不得被丢）',
  );
});

test('EventPersister: flush() 返回后其快照已写入（不早于在飞写入完成）', async () => {
  const storage = new RecordingStorage();
  const events: SessionEvent[] = [evt('a')];
  const persister = new EventPersister(storage, 's1', () => [...events], { batchDelayMs: 0 });

  storage.hold();
  const first = persister.flush();
  await new Promise((r) => setImmediate(r)); // 等第一次进入在飞状态
  events.push(evt('b'));
  const second = persister.flush();
  storage.release();
  await second; // 原实现在这里立即返回（写入尚未发生）
  assert.strictEqual(storage.writes.length, 2, 'await flush() 返回时，它的快照必须已经落盘');
  await first;
});

test('EventPersister: 事件数未变则跳过写入（增量语义）', async () => {
  const storage = new RecordingStorage();
  const events: SessionEvent[] = [evt('a')];
  const persister = new EventPersister(storage, 's1', () => events, { batchDelayMs: 0 });
  await persister.flush();
  await persister.flush();
  await persister.flush();
  assert.deepStrictEqual(storage.writes, [['a']]);

  events.push(evt('b'));
  await persister.flush();
  assert.deepStrictEqual(storage.writes, [['a'], ['a', 'b']]);
});

test('EventPersister: 空事件不写；落盘失败降级为 warn 且不抛错（fail-soft）', async () => {
  const storage = new RecordingStorage();
  const events: SessionEvent[] = [];
  const persister = new EventPersister(storage, 's1', () => events, { batchDelayMs: 0 });
  await persister.flush();
  assert.strictEqual(storage.writes.length, 0, '空历史不应产生写入');

  events.push(evt('a'));
  storage.failNext = true;
  await persister.flush(); // 不抛错
  assert.strictEqual(storage.writes.length, 0);
  await persister.flush(); // 失败不推进 lastSavedCount ⇒ 下一次重试同一批
  assert.deepStrictEqual(storage.writes, [['a']]);
});

test('EventPersister: schedule 走定时器落盘，dispose 后不再排程也不再落盘', async () => {
  const storage = new RecordingStorage();
  const events: SessionEvent[] = [evt('a')];
  const persister = new EventPersister(storage, 's1', () => events, { batchDelayMs: 5 });
  persister.schedule();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(storage.writes, [['a']], '定时器到期应落盘一次');

  events.push(evt('b'));
  persister.dispose();
  persister.schedule();
  await persister.flush();
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(storage.writes.length, 1, 'dispose 后不得再写入');
});
