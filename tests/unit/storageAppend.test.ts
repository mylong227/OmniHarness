/**
 * **追加落盘通道**的判据（G7，2026-10-03 第八轮）。
 *
 * ## 背景（看板 §8.3 实测）
 *
 * 事件溯源架构主张"只追加"，但三个存储适配器原先都只有全量 `save`：`jsonl` 整文件 tmp+rename、
 * `sqlite` 一个事务里 `DELETE` 全桶 + 逐条 `INSERT`。而 `EventPersister` **每步**都落一次盘
 * ⇒ 单次成本随事件数**线性**增长（实测 200 条 ≈28 ms/89 KB、3,200 条 ≈41 ms/1.6 MB、
 * 12,800 条 ≈139 ms/6.5 MB），长会话累计写入达 `size_N × 步数 / 2`。
 *
 * ## 判据（报告 §4 给 G7 的口径：追加路径与全量路径 `load()` 逐条深相等）
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `jsonl` 追加后 `load()` 与全量 `save` 的结果**逐条深相等**，且文件只增长了尾部字节 |
 * | ② | `jsonl` 前缀校验 fail-closed：文件被外部改动过 ⇒ `append` **抛错**（不"尽力追加"） |
 * | ③ | `sqlite` 追加不 `DELETE`（外部插入的行存活）、条数正确、`load()` 与全量一致 |
 * | ④ | `EventPersister` 首次全量、其后走追加：写入量随"新增条数"而非"总条数"增长 |
 * | ⑤ | 追加失败 ⇒ 回退全量，最终 `load()` 仍与内存态**逐条深相等**（历史绝不错乱/丢失） |
 * | ⑥ | 回卷（`rewindTo`）必须走**全量**（截断语义追加表达不了），且盘上结果与内存一致 |
 *
 * ⑥ 特别重要：追加只能表达"多写"，回滚是"少写"。若回卷误走追加，盘上会留下已被回滚掉的事件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SqliteStorage } from '../../src/adapters/storage/sqliteStorage.js';
import { EventPersister } from '../../src/core/loop/eventPersister.js';
import type { StoragePort } from '../../src/ports/memory/storage.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * 造一条事件。
 * @param seq 序号（写进 id 与 payload，便于逐条比对）。
 * @returns 会话事件。
 */
function eventOf(seq: number): SessionEvent {
  return {
    id: `e${String(seq)}`,
    type: 'user',
    sessionId: 's1',
    timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    payload: { content: `第 ${String(seq)} 条` },
  } as SessionEvent;
}

/**
 * 造 n 条事件。
 * @param n 条数。
 * @returns 事件数组。
 */
function eventsOf(n: number): SessionEvent[] {
  return Array.from({ length: n }, (_unused, i) => eventOf(i));
}

/**
 * 记录写入量的存储装饰器：区分「全量 save」与「追加」，并累计**接口级写入条数**。
 *
 * 为什么量"条数"而不是墙钟：门禁在并行下跑，时间量测会被 CPU 争抢污染（G8 已实证），
 * 而"每次落盘写了多少条"是确定性的——写放大的本质就是这个量。
 */
class RecordingStorage implements StoragePort {
  /** 全量 save 的调用次数。 */
  public saves = 0;
  /** 追加调用次数。 */
  public appends = 0;
  /** 接口级累计写入条数（save 记全量、append 只记尾部）。 */
  public writtenEvents = 0;
  /** 最近一次 save 写入的条数（用于算"若全量写会写多少"）。 */
  public lastSaveSize = 0;

  /**
   * @param inner 被装饰的真实存储。
   * @param failAppendAt 第几次 append 抛错（用于验证回退；0 ＝ 不抛）。
   */
  public constructor(
    private readonly inner: StoragePort,
    private failAppendAt = 0,
  ) {}

  /** 存储名（透传内层，便于按后端分支的逻辑不受影响）。 */
  public get name(): string {
    return this.inner.name;
  }

  /** 全量保存（记全量条数）。
   * @param sessionId 会话标识。
   * @param events 完整事件列表。
   * @returns 无返回值。
   */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    this.saves += 1;
    this.writtenEvents += events.length;
    this.lastSaveSize = events.length;
    await this.inner.save(sessionId, events);
  }

  /** 加载（透传）。
   * @param sessionId 会话标识。
   * @returns 事件列表。
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    return this.inner.load(sessionId);
  }

  /** 追加（可注入失败；只记尾部条数）。
   * @param sessionId 会话标识。
   * @param events 完整事件列表。
   * @param fromCount 声明已有条数。
   * @returns 无返回值。
   */
  public async append(
    sessionId: string,
    events: readonly SessionEvent[],
    fromCount: number,
  ): Promise<void> {
    this.appends += 1;
    if (this.failAppendAt > 0 && this.appends === this.failAppendAt) {
      throw new Error('注入的追加失败（测试用）');
    }
    this.writtenEvents += events.length - fromCount;
    await this.inner.append?.(sessionId, events, fromCount);
  }
}

test('① jsonl 追加与全量 load() 逐条深相等，且文件**恰好**只增长尾部字节', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-append-'));
  try {
    const storage = new JsonlStorage(dir);
    const first = eventsOf(50);
    await storage.save('s1', first);
    const bytesAfterSave = statSync(join(dir, 's1.jsonl')).size;

    const tail = eventsOf(80).map((_unused, i) => eventOf(50 + i));
    const all = [...first, ...tail];
    await storage.append('s1', all, 50);
    assert.deepStrictEqual(await storage.load('s1'), all, '追加后必须与完整列表逐条深相等');

    // 精确断言：文件增长量**恰好等于尾部载荷的字节数**。多一个字节都意味着前缀被重写过。
    const tailBytes = Buffer.byteLength(
      `${tail.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
    assert.strictEqual(
      statSync(join(dir, 's1.jsonl')).size - bytesAfterSave,
      tailBytes,
      '追加的文件增长量必须恰为尾部字节数（多出即说明前缀被重写）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② jsonl 前缀校验 fail-closed：文件被外部改动后 append 必须抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-append-'));
  try {
    const storage = new JsonlStorage(dir);
    await storage.save('s1', eventsOf(10));
    // 外部改动（模拟"另一个进程/归档工具动过这个文件"）——追加必须拒绝，绝不能写歪。
    writeFileSync(join(dir, 's1.jsonl'), '外部写入\n', { flag: 'a' });
    await assert.rejects(
      () => storage.append('s1', eventsOf(12), 10),
      /前置校验失败/,
      '前缀不符时宁抛勿猜（否则历史会永久错乱且表面正常）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ sqlite 追加不 DELETE（外部行存活）、条数正确、load() 与全量一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-append-'));
  const file = join(dir, 'sessions.db');
  let storage: SqliteStorage | undefined;
  try {
    storage = new SqliteStorage(file);
    const first = eventsOf(20);
    await storage.save('s1', first);
    const tail = eventsOf(5).map((_u, i) => eventOf(20 + i));
    await storage.append('s1', [...first, ...tail], 20);
    const loaded = await storage.load('s1');
    assert.strictEqual(loaded.length, 25, '追加后条数应为 20 + 5');
    assert.deepStrictEqual(loaded, [...first, ...tail]);

    // 精确判据「追加路径没有 DELETE 前缀」：把**桶内一行**改成哨兵值（seq 仍在声明范围内，
    // 故条数校验照常通过），再追加一批。若实现走的是 `DELETE 全桶 + 重插`，这一行必被旧数据覆盖；
    // 只写 seq ≥ fromCount 的真追加则会**原样保留**它。
    const db = (
      storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
    ).db;
    db.prepare('UPDATE events SET data = ? WHERE session_id = ? AND seq = ?').run(
      JSON.stringify({ sentinel: true }),
      's1',
      3,
    );
    const tail2 = eventsOf(6).map((_u, i) => eventOf(25 + 20 + i));
    await storage.append('s1', [...first, ...tail, ...tail2], 25);
    const after = await storage.load('s1');
    assert.strictEqual(after.length, 31, '追加后条数应为 25 + 6');
    assert.deepStrictEqual(
      after[3],
      { sentinel: true },
      '桶内既有行必须原样保留 ⇒ 追加路径没有 DELETE/重写前缀（这正是写放大的来源）',
    );
  } finally {
    if (storage !== undefined) {
      (storage as unknown as { close: () => void }).close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ EventPersister：首次全量、其后追加；写入量随"新增条数"而非"总条数"增长', async () => {
  const inner = new MemoryStorage();
  const recorder = new RecordingStorage(inner);
  let events: SessionEvent[] = [];
  const persister = new EventPersister(recorder, 's1', () => events, { batchDelayMs: 0 });

  // 模拟 4 次落盘，每次新增 10 条，总数 10/20/30/40。
  for (let flush = 1; flush <= 4; flush += 1) {
    events = eventsOf(flush * 10);
    await persister.flush();
  }
  assert.strictEqual(recorder.saves, 1, '只有首次（无可比对前缀）走全量');
  assert.strictEqual(recorder.appends, 3, '其后三次必须走追加');
  assert.strictEqual(
    recorder.writtenEvents,
    10 + 10 + 10 + 10,
    '接口级写入条数应等于新增总数（40）：全量重写会是 10+20+30+40=100',
  );
  assert.deepStrictEqual(await inner.load('s1'), events, '最终盘上内容必须与内存态逐条深相等');
});

test('⑤ 追加失败 ⇒ 回退全量，最终 load() 仍与内存态逐条深相等', async () => {
  const inner = new MemoryStorage();
  const recorder = new RecordingStorage(inner, 2); // 第 2 次 append 抛错
  let events: SessionEvent[] = [];
  const persister = new EventPersister(recorder, 's1', () => events, { batchDelayMs: 0 });
  for (let flush = 1; flush <= 3; flush += 1) {
    events = eventsOf(flush * 7);
    await persister.flush();
  }
  // 三次 flush：第 1 次全量（无可比对前缀）；第 2 次追加成功；第 3 次追加失败 ⇒ 回退全量。
  assert.strictEqual(recorder.appends, 2, '第 2、3 次 flush 各尝试过一次追加');
  assert.strictEqual(recorder.saves, 2, '首次全量 + 追加失败后的回退全量');
  assert.deepStrictEqual(
    await inner.load('s1'),
    events,
    '无论走哪条路径，盘上内容都必须与内存态一致——追加失败绝不能造成历史错乱或丢失',
  );
});

test('⑦ 适配器不实现 append ⇒ 自动回落全量（第三方/云后端零改动兼容）', async () => {
  // 板 §8.3 的回退路径："适配器不实现 append 即自动回到现有行为"。这条要钉住：
  // 新通道是**可选**能力，任何未实现它的后端（云存储、第三方插件、测试替身）都必须照常工作。
  const inner = new MemoryStorage();
  const withoutAppend: StoragePort = {
    name: inner.name,
    save: (sessionId, events) => inner.save(sessionId, events),
    load: (sessionId) => inner.load(sessionId),
  };
  assert.strictEqual(withoutAppend.append, undefined, '前置：该替身确实没有追加通道');

  let events: SessionEvent[] = [];
  const persister = new EventPersister(withoutAppend, 's1', () => events, { batchDelayMs: 0 });
  for (let flush = 1; flush <= 3; flush += 1) {
    events = eventsOf(flush * 5);
    await persister.flush();
  }
  assert.deepStrictEqual(
    await inner.load('s1'),
    events,
    '无追加能力的后端必须靠全量 save 得到一致结果',
  );
});

test('⑥ 回卷（截断）必须走全量：追加表达不了"少写"', async () => {
  const inner = new MemoryStorage();
  const recorder = new RecordingStorage(inner);
  let events: SessionEvent[] = [];
  const persister = new EventPersister(recorder, 's1', () => events, { batchDelayMs: 0 });
  events = eventsOf(30);
  await persister.flush();
  const savesBefore = recorder.saves;

  events = eventsOf(12);
  await persister.rewindTo(12);
  assert.strictEqual(recorder.appends, 0, '回卷不得走追加（截断语义追加表达不了）');
  assert.ok(recorder.saves > savesBefore, '回卷必须触发一次全量写入');
  assert.deepStrictEqual(
    await inner.load('s1'),
    eventsOf(12),
    '盘上必须是截断后的内容——否则被回滚掉的事件会留在盘上',
  );
  // 证据：jsonl 情境下这一步必然把文件缩短（全量 tmp+rename），而不是继续增长。
  const dir = mkdtempSync(join(tmpdir(), 'omni-append-'));
  try {
    const jsonl = new JsonlStorage(dir);
    await jsonl.save('s1', eventsOf(30));
    const before = statSync(join(dir, 's1.jsonl')).size;
    await jsonl.save('s1', eventsOf(12));
    const after = statSync(join(dir, 's1.jsonl')).size;
    assert.ok(after < before, '全量重写应把文件缩回截断后的长度');
    assert.strictEqual(
      readFileSync(join(dir, 's1.jsonl'), 'utf8').trim().split('\n').length,
      12,
      '文件行数应等于截断后的条数',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
