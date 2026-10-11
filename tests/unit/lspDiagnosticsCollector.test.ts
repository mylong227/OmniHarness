import { strict as assert } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  LspDiagnosticsCollector,
  type DiagnosticsTimerHandle,
  type DiagnosticsTimers,
} from '../../src/adapters/lsp/lspDiagnosticsCollector.js';
import { LspUri } from '../../src/adapters/lsp/lspUri.js';

/**
 * 记录式假定时器。
 *
 * 为什么需要它：本类的铁律是「等待类定时器必须被 `clear()` / 超时路径清理」，
 * 而缺省实现下「清没清」在外部完全不可见（清与不清只差一个拿不到的句柄）。
 * 换成记录式定时器后，「创建了几个、清理了几个、还挂着几个」变成可断言的事实。
 */
class RecordingTimers implements DiagnosticsTimers {
  /** 已登记且尚未触发、尚未清理的定时器。 */
  private readonly pending = new Map<DiagnosticsTimerHandle, () => void>();
  /** 收到过 `cancel` 的句柄（重复清理只记一次）。 */
  public readonly cancelled = new Set<DiagnosticsTimerHandle>();
  /** 收到的等待窗口毫秒数（按调度顺序）。 */
  public readonly timeouts: number[] = [];
  /** 调度总次数。 */
  public scheduled = 0;
  /** 最近一次调度的句柄（测试据此触发超时）。 */
  public last: DiagnosticsTimerHandle | undefined;
  /** 句柄自增序号（保证句柄身份唯一，便于断言"只清理自己那个"）。 */
  private seq = 0;

  /**
   * 登记一个定时器（替身只记账，不真的起计时器）。
   *
   * @param handler 到点回调。
   * @param timeoutMs 等待窗口毫秒数。
   * @returns 新句柄。
   */
  public schedule(handler: () => void, timeoutMs: number): DiagnosticsTimerHandle {
    this.scheduled += 1;
    this.timeouts.push(timeoutMs);
    const handle = { seq: (this.seq += 1) } as unknown as DiagnosticsTimerHandle;
    this.pending.set(handle, handler);
    this.last = handle;
    return handle;
  }

  /**
   * 取消定时器（重复取消幂等）。
   *
   * @param handle 待取消句柄。
   * @returns 无返回值。
   */
  public cancel(handle: DiagnosticsTimerHandle): void {
    this.cancelled.add(handle);
    this.pending.delete(handle);
  }

  /**
   * 触发到点（模拟超时）。
   *
   * @param handle 待触发的句柄（`undefined` 视为测试写错，直接失败）。
   * @returns 无返回值。
   */
  public fire(handle: DiagnosticsTimerHandle | undefined): void {
    assert.notEqual(handle, undefined, 'fire 需要先 awaitPublish 过一个句柄');
    const key = handle as DiagnosticsTimerHandle;
    const handler = this.pending.get(key);
    // 到点即脱离事件循环：此后它不再算「挂着的定时器」。
    this.pending.delete(key);
    assert.notEqual(handler, undefined, '该句柄已被清理，不应再被触发');
    handler?.();
  }

  /** 仍未被清理也未被触发的定时器数量（泄漏判据：任何场景结束后都必须是 0）。 */
  public get outstanding(): number {
    return this.pending.size;
  }
}

const NOTIF = LspDiagnosticsCollector.NOTIFICATION_METHOD;

/** 一条最简合法原始诊断（0-based 坐标，severity 1 = Error）。 */
const rawDiagnostic = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1,
  message: 'boom',
  ...patch,
});

/** 让已排队的微任务跑完（用于观察「某个 Promise 此刻是否仍未 settle」）。 */
const flush = async (): Promise<void> => {
  await new Promise<void>((settle) => setImmediate(settle));
};

/** 造一个带假定时器的收集器。 */
const collectorWith = (timers: RecordingTimers): LspDiagnosticsCollector =>
  new LspDiagnosticsCollector(timers);

test('accept：只消费 publishDiagnostics；方法名与参数不合法一律不消费（fail-closed）', () => {
  const collector = collectorWith(new RecordingTimers());
  const file = 'x:/repo/border.ts';

  assert.strictEqual(
    collector.accept('textDocument/didOpen', { uri: file, diagnostics: [] }),
    false,
  );
  assert.strictEqual(collector.accept(NOTIF, null), false);
  assert.strictEqual(collector.accept(NOTIF, {}), false);
  assert.strictEqual(collector.accept(NOTIF, { uri: null }), false);
  assert.strictEqual(collector.accept(NOTIF, { uri: 42, diagnostics: [] }), false);
  // 全部被拒 ⇒ 缓存必须仍是空的：一记坏推送若被当成有效推送，下游会把 stale 当「无错误」。
  assert.deepEqual(collector.cached(file), []);
  assert.strictEqual(collector.accept(NOTIF, { uri: file, diagnostics: [] }), true);
});

test('归一化：0-based 坐标转 1-based，severity 1/3/4 分别映射且缺失或未知按 warning', () => {
  const collector = collectorWith(new RecordingTimers());
  const file = 'x:/repo/severity.ts';
  collector.accept(NOTIF, {
    uri: file,
    diagnostics: [
      rawDiagnostic({
        severity: 1,
        range: { start: { line: 4, character: 1 }, end: { line: 5, character: 2 } },
      }),
      rawDiagnostic({ severity: 2 }),
      rawDiagnostic({ severity: 3 }),
      rawDiagnostic({ severity: 4 }),
      rawDiagnostic({ severity: undefined }),
      rawDiagnostic({ severity: 'error' }),
      rawDiagnostic({ severity: 99 }),
    ],
  });
  const got = collector.cached(file);
  assert.deepEqual(
    got.map((diagnostic) => diagnostic.severity),
    ['error', 'warning', 'info', 'hint', 'warning', 'warning', 'warning'],
  );
  assert.deepEqual(got[0]?.range, {
    start: { line: 5, character: 2 },
    end: { line: 6, character: 3 },
  });
});

test('归一化：source/code 仅在类型合法时保留；结构非法条目逐条剔除而不拖垮整批', () => {
  const collector = collectorWith(new RecordingTimers());
  const file = 'x:/repo/shape.ts';
  collector.accept(NOTIF, {
    uri: file,
    diagnostics: [
      rawDiagnostic({ source: 'ts', code: 2304, message: 'Cannot find name' }),
      rawDiagnostic({ source: 7, code: { nested: true } }),
      rawDiagnostic({ range: undefined }),
      rawDiagnostic({ range: { start: { line: 0 }, end: { line: 0, character: 1 } } }),
      null,
      'not-an-object',
      rawDiagnostic({ source: 'eslint', code: 'E1' }),
    ],
  });
  const got = collector.cached(file);
  assert.strictEqual(got.length, 3);
  assert.deepEqual(got[0], {
    file,
    range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
    severity: 'error',
    message: 'Cannot find name',
    source: 'ts',
    code: '2304',
  });
  // 非 string 的 source / 非 string|number 的 code 必须整字段缺席，而不是留个 `source: 7`。
  assert.deepEqual(Object.keys(got[1] ?? {}).sort(), ['file', 'message', 'range', 'severity']);
  assert.strictEqual(got[2]?.code, 'E1');
  assert.strictEqual(got[2]?.source, 'eslint');
});

test('归一化：diagnostics 非数组时缓存空数组，accept 仍报「已消费」', () => {
  const collector = collectorWith(new RecordingTimers());
  const file = 'x:/repo/notarray.ts';
  assert.strictEqual(collector.accept(NOTIF, { uri: file, diagnostics: 'oops' }), true);
  assert.deepEqual(collector.cached(file), []);
  assert.strictEqual(collector.accept(NOTIF, { uri: file, diagnostics: null }), true);
  assert.deepEqual(collector.cached(file), []);
});

test('版本更新语义：同文件后一次推送整体覆盖前一次（不合并、不追加）', () => {
  const collector = collectorWith(new RecordingTimers());
  const file = 'x:/repo/overwrite.ts';
  collector.accept(NOTIF, {
    uri: file,
    diagnostics: [rawDiagnostic({ message: 'old-1' }), rawDiagnostic({ message: 'old-2' })],
  });
  assert.strictEqual(collector.cached(file).length, 2);
  collector.accept(NOTIF, { uri: file, diagnostics: [rawDiagnostic({ message: 'new-1' })] });
  const got = collector.cached(file);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0]?.message, 'new-1');
});

test('缓存键是归一化后的文件路径：file:// URI 与裸路径命中同一份缓存', () => {
  const collector = collectorWith(new RecordingTimers());
  const absolute = resolve(process.cwd(), 'normalizeProbe.ts');
  collector.accept(NOTIF, {
    uri: LspUri.fileToUri(absolute),
    diagnostics: [rawDiagnostic()],
  });
  assert.strictEqual(collector.cached(absolute).length, 1);
});

test('推送唤醒同文件等待者，并清理其超时定时器（无泄漏）', async () => {
  const timers = new RecordingTimers();
  const collector = collectorWith(timers);
  const file = 'x:/repo/wake.ts';

  const pending = collector.awaitPublish(file, 4321);
  assert.deepEqual(timers.timeouts, [4321]);
  assert.strictEqual(timers.outstanding, 1);

  assert.strictEqual(collector.accept(NOTIF, { uri: file, diagnostics: [] }), true);
  assert.strictEqual(await pending, true);
  assert.strictEqual(timers.scheduled, 1);
  assert.strictEqual(timers.cancelled.size, 1);
  assert.strictEqual(timers.outstanding, 0);
});

test('只唤醒目标文件的等待者：并发等待互不误伤', async () => {
  const timers = new RecordingTimers();
  const collector = collectorWith(timers);
  const fileA = 'x:/repo/a.ts';
  const fileB = 'x:/repo/b.ts';
  const order: string[] = [];

  const pendingA = collector.awaitPublish(fileA, 1000).then((received) => {
    order.push(`a:${String(received)}`);
    return received;
  });
  const pendingB = collector.awaitPublish(fileB, 1000).then((received) => {
    order.push(`b:${String(received)}`);
    return received;
  });

  collector.accept(NOTIF, { uri: fileB, diagnostics: [] });
  await flush();
  assert.deepEqual(order, ['b:true']);
  assert.strictEqual(timers.outstanding, 1, 'A 的定时器此时必须仍然挂着');

  collector.accept(NOTIF, { uri: fileA, diagnostics: [] });
  assert.strictEqual(await pendingA, true);
  assert.strictEqual(await pendingB, true);
  assert.strictEqual(timers.outstanding, 0);
});

test('超时路径：到点 resolve(false)、摘除登记项，此后推送不再触碰该定时器', async () => {
  const timers = new RecordingTimers();
  const collector = collectorWith(timers);
  const file = 'x:/repo/timeout.ts';

  const pending = collector.awaitPublish(file, 50);
  timers.fire(timers.last);
  assert.strictEqual(await pending, false);
  assert.strictEqual(timers.outstanding, 0);
  assert.strictEqual(timers.cancelled.size, 0, '到点即脱离事件循环，不该再走 cancel');

  // 关键判据：超时若没有摘除登记项，这条推送就会去 cancel 一个早已到点的句柄。
  collector.accept(NOTIF, { uri: file, diagnostics: [] });
  assert.strictEqual(timers.cancelled.size, 0);
});

test('clear：清空缓存、唤醒全部等待者并清理全部定时器；之后推送不再唤醒旧等待者', async () => {
  const timers = new RecordingTimers();
  const collector = collectorWith(timers);
  const fileA = 'x:/repo/clear-a.ts';
  const fileB = 'x:/repo/clear-b.ts';

  collector.accept(NOTIF, { uri: fileA, diagnostics: [rawDiagnostic()] });
  const pendingA = collector.awaitPublish(fileA, 1000);
  const pendingB = collector.awaitPublish(fileB, 1000);
  assert.strictEqual(timers.outstanding, 2);

  collector.clear();
  assert.deepEqual(collector.cached(fileA), []);
  assert.strictEqual(await pendingA, false);
  assert.strictEqual(await pendingB, false);
  assert.strictEqual(timers.cancelled.size, 2);
  assert.strictEqual(timers.outstanding, 0);

  collector.accept(NOTIF, { uri: fileA, diagnostics: [] });
  assert.strictEqual(timers.cancelled.size, 2, '登记项已随 clear 摘除，不应被二次触碰');
});

test('缓存上限：第 513 个文件写入时淘汰最早一条，且只淘汰一条', () => {
  const collector = collectorWith(new RecordingTimers());
  const key = (index: number): string => `x:/repo/evict/${index}.ts`;
  for (let index = 0; index < 513; index += 1) {
    collector.accept(NOTIF, { uri: key(index), diagnostics: [rawDiagnostic()] });
  }
  assert.deepEqual(collector.cached(key(0)), [], '最早写入的一条必须被淘汰');
  assert.strictEqual(collector.cached(key(1)).length, 1, '次早的一条仍在：淘汰是逐条的');
  assert.strictEqual(collector.cached(key(512)).length, 1);
});

test('铁律：awaitPublish 之后定时器仍引用事件循环（不得对它 unref）', async () => {
  const handles: DiagnosticsTimerHandle[] = [];
  const timers: DiagnosticsTimers = {
    schedule: (handler, timeoutMs) => {
      const handle = setTimeout(handler, timeoutMs);
      handles.push(handle);
      return handle;
    },
    cancel: (handle) => clearTimeout(handle),
  };
  const collector = new LspDiagnosticsCollector(timers);

  const pending = collector.awaitPublish('x:/repo/ref.ts', 5000);
  const handle = handles[0];
  assert.notEqual(handle, undefined);
  // unref 过的定时器不再引用事件循环：一旦别处没有句柄，到点也不会触发，守卫静默失效。
  assert.strictEqual(handle?.hasRef(), true);

  collector.clear();
  assert.strictEqual(await pending, false);
});

test('铁律：除该定时器外无其他句柄时，事件循环必须撑到超时（子进程实测）', () => {
  const collectorUrl = new URL('../../src/adapters/lsp/lspDiagnosticsCollector.js', import.meta.url)
    .href;
  const script = [
    `const { LspDiagnosticsCollector } = await import(${JSON.stringify(collectorUrl)});`,
    'const collector = new LspDiagnosticsCollector();',
    "const received = await collector.awaitPublish('x:/repo/never.ts', 120);",
    "process.stdout.write('SETTLED:' + String(received));",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
  });
  // 定时器若被 unref，脚本所在的事件循环会提前排空：stdout 为空、退出码 13（TLA 未结）。
  assert.strictEqual(child.stdout, 'SETTLED:false');
  assert.strictEqual(child.status, 0);
});

test('缺省定时器（无注入）：超时会真的触发、推送会真的唤醒（两条路径都走默认 set/clear）', async () => {
  const collector = new LspDiagnosticsCollector();
  const started = Date.now();
  assert.strictEqual(await collector.awaitPublish('x:/repo/realTimeout.ts', 40), false);
  assert.ok(Date.now() - started >= 25, '必须在等待窗口之后才返回 false');

  const file = 'x:/repo/realSettle.ts';
  const pending = collector.awaitPublish(file, 5000);
  assert.strictEqual(collector.accept(NOTIF, { uri: file, diagnostics: [] }), true);
  assert.strictEqual(await pending, true, '推送必须走默认 clearTimeout 把 5s 定时器摘掉');
});
