/**
 * `SpawnMediaProcessRunner` 真判据：用**替身进程**把「超时真杀、输出截断、ENOENT 不炸宿主、
 * 收尾清理到位」四件事钉死，全程不需要本机装 ffmpeg/ffprobe。
 *
 * ## 判据为什么不是恒真
 *
 * | 判据 | 反面对照（错误实现会怎样） | 该判据会怎样变红 |
 * | --- | --- | --- |
 * | 输出超限即停 | 继续累积 ⇒ `stdout.length` 超过 `maxOutputBytes` | 断言 `stdout.length === 上限` |
 * | 超时到点强杀 | 只置标记不杀 ⇒ `kill()` 次数为 0 | 断言 `kills() === 1` |
 * | 收尾清计时器 | 不 `clearTimeout` ⇒ 结束后计时器仍到点杀进程 | 断言「结束后再等一个超时窗口，`kills()` 仍为 0」 |
 * | 收尾摘 abort 监听 | 不 `removeEventListener` ⇒ 结束后的取消信号仍打到旧进程 | 断言「结束后 `abort()`，`kills()` 仍为 0」 |
 * | ENOENT 不炸宿主 | 不监听 `error` ⇒ 未捕获异常炸掉进程 | 断言 `spawnError` 如实回传且 Promise 正常 settle |
 * | 缺省缝仍是真 spawn | 缝被误接成桩 ⇒ 不存在的二进制不会报 ENOENT | 末条用例真跑一次不存在的二进制 |
 *
 * 唯一豁免：没有「装了 ffmpeg 才跑」的开关——所有判据要么走替身，要么跑一个**必然不存在**
 * 的可执行文件名（两种平台都只会得到 ENOENT，与是否装 ffmpeg 无关）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SpawnMediaProcessRunner,
  type MediaChildSpawner,
} from '../../src/adapters/media/spawnMediaProcessRunner.js';
import type { SpawnedMediaChild } from '../../src/adapters/media/spawnMediaProcessRunner.js';
import type { MediaProcessRequest } from '../../src/adapters/media/mediaProcessRunner.js';

/** stderr 上限的独立复算值（与实现常量同值；用来断言「确实被截到 256 KiB」）。 */
const EXPECTED_STDERR_LIMIT = 256 * 1024;

/**
 * 替身子进程：手工驱动 `data`/`error`/`close` 事件，并记录 `kill()` 调用次数。
 *
 * 之所以要替身而不是真跑 ffmpeg：本类的判定全在事件回调里，而事件时序（先 error 还是先 close、
 * 超时与 close 的先后）在真实进程上不可控。
 */
class FakeMediaChild implements SpawnedMediaChild {
  /** 已注册的 stdout `data` 监听器。 */
  private readonly stdoutListeners: Array<(chunk: Buffer) => void> = [];

  /** 已注册的 stderr `data` 监听器。 */
  private readonly stderrListeners: Array<(chunk: Buffer) => void> = [];

  /** 已注册的 `error` 监听器。 */
  private readonly errorListeners: Array<(error: Error) => void> = [];

  /** 已注册的 `close` 监听器。 */
  private readonly closeListeners: Array<(code: number | null) => void> = [];

  /** `kill()` 的调用次数（超时、取消、收尾清理三条判据都看它）。 */
  private killCalls = 0;

  /** stdout 数据流（替身只登记监听器）。 */
  public readonly stdout: SpawnedMediaChild['stdout'] = {
    on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
      this.stdoutListeners.push(listener);
    },
  };

  /** stderr 数据流（替身只登记监听器）。 */
  public readonly stderr: SpawnedMediaChild['stderr'] = {
    on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
      this.stderrListeners.push(listener);
    },
  };

  /**
   * 订阅 `error` 事件（重载声明）。
   *
   * @param event 事件名（`'error'`）。
   * @param listener 收到错误对象的回调。
   * @returns 无返回值。
   */
  public on(event: 'error', listener: (error: Error) => void): void;
  /**
   * 订阅 `close` 事件（重载声明）。
   *
   * @param event 事件名（`'close'`）。
   * @param listener 收到退出码（被信号杀掉为 `null`）的回调。
   * @returns 无返回值。
   */
  public on(event: 'close', listener: (code: number | null) => void): void;
  /**
   * 订阅 `error` / `close` 事件（实现签名）。
   *
   * @param event 事件名。
   * @param listener 事件回调（按事件名分流到对应监听器表）。
   * @returns 无返回值。
   */
  public on(
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null) => void),
  ): void {
    if (event === 'error') {
      this.errorListeners.push(listener as (error: Error) => void);
      return;
    }
    this.closeListeners.push(listener as (code: number | null) => void);
  }

  /**
   * 终止进程（替身只计数，不产生副作用）。
   *
   * @returns 无返回值。
   */
  public kill(): void {
    this.killCalls += 1;
  }

  /**
   * 读取 `kill()` 的调用次数。
   *
   * @returns 调用次数。
   */
  public kills(): number {
    return this.killCalls;
  }

  /**
   * 推一段 stdout 数据。
   *
   * @param chunk 数据块。
   * @returns 无返回值。
   */
  public pushStdout(chunk: Buffer): void {
    for (const listener of this.stdoutListeners) {
      listener(chunk);
    }
  }

  /**
   * 推一段 stderr 数据。
   *
   * @param chunk 数据块。
   * @returns 无返回值。
   */
  public pushStderr(chunk: Buffer): void {
    for (const listener of this.stderrListeners) {
      listener(chunk);
    }
  }

  /**
   * 触发 `error`（如 ENOENT）。
   *
   * @param error 错误对象。
   * @returns 无返回值。
   */
  public emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  /**
   * 触发 `close`。
   *
   * @param code 退出码（被信号杀掉为 `null`）。
   * @returns 无返回值。
   */
  public emitClose(code: number | null): void {
    for (const listener of this.closeListeners) {
      listener(code);
    }
  }
}

/** 一次启动记录。 */
interface LaunchRecord {
  /** 可执行文件名。 */
  readonly command: string;
  /** 参数数组。 */
  readonly args: readonly string[];
}

/**
 * 注入一条替身启动函数，并记录每次启动的 command/args。
 *
 * @param child 要交给执行器的替身进程。
 * @returns 启动函数与记录数组。
 */
const useFakeSpawn = (
  child: FakeMediaChild,
): { readonly spawn: MediaChildSpawner; readonly launched: LaunchRecord[] } => {
  const launched: LaunchRecord[] = [];
  const spawn: MediaChildSpawner = (command, args) => {
    launched.push({ command, args });
    return child;
  };
  return { spawn, launched };
};

/**
 * 造一条执行请求（缺省值都合法，单条判据只覆盖它关心的那一项）。
 *
 * @param overrides 覆盖项。
 * @returns 执行请求。
 */
const requestOf = (overrides: Partial<MediaProcessRequest> = {}): MediaProcessRequest => ({
  command: 'ffmpeg',
  args: ['-nostdin'],
  timeoutMs: 1000,
  maxOutputBytes: 1024,
  ...overrides,
});

test('正常退出：退出码与 stdout/stderr 原样回传，三个异常标记全为假', async () => {
  const child = new FakeMediaChild();
  const { spawn, launched } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  // 参数里带引号、逗号、& 与 |：走 shell 必炸的形态。
  // 末尾那条**含空格**的参数是关键：若有人把 argv 拼成字符串再交给 shell/按空格切分，
  // 它会被拆成两个参数——`deepStrictEqual` 立刻看见。
  const args = Object.freeze([
    '-nostdin',
    '-vf',
    "select='gt(scene,0.3)',scale=320:-1",
    '-metadata',
    'title=Omni Harness',
    'a&b|c',
  ]);
  const pending = runner.run(requestOf({ args }));
  child.pushStdout(Buffer.from('ffmpeg version 7.0'));
  child.pushStderr(Buffer.from('banner'));
  child.emitClose(0);
  const outcome = await pending;

  assert.strictEqual(outcome.exitCode, 0, '退出码如实回传');
  assert.strictEqual(outcome.stdout.toString('utf8'), 'ffmpeg version 7.0', 'stdout 原样回传');
  assert.strictEqual(outcome.stderr, 'banner', 'stderr 以 utf8 文本回传');
  assert.strictEqual(outcome.timedOut, false, '正常退出不得报超时');
  assert.strictEqual(outcome.truncated, false, '正常体量不得报截断');
  assert.strictEqual(outcome.spawnError, undefined, '正常启动不得报启动失败');
  assert.deepStrictEqual(
    launched,
    [{ command: 'ffmpeg', args: [...args] }],
    'command/args 必须逐字传给 spawn（冻结数组也没被就地修改）',
  );
});

test('非零退出码：如实回传，且 stdout 仍然保留（失败也要留下现场）', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf());
  child.pushStdout(Buffer.from('partial'));
  child.pushStderr(Buffer.from('Invalid data found'));
  child.emitClose(1);
  const outcome = await pending;

  assert.strictEqual(outcome.exitCode, 1, '非零退出码不得被吞成 0 或 null');
  assert.strictEqual(outcome.stdout.toString('utf8'), 'partial', '失败路径也要留下已产出的 stdout');
  assert.strictEqual(outcome.stderr, 'Invalid data found', 'stderr 是诊断的主要来源');
  assert.strictEqual(outcome.timedOut, false, '非零退出 ≠ 超时');
  assert.strictEqual(outcome.spawnError, undefined, '进程启动成功过，就不该报 ENOENT');
});

test('被信号终止（close 的 code 为 null）：exitCode 为 null 且不误报为超时', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf());
  child.emitClose(null);
  const outcome = await pending;

  assert.strictEqual(outcome.exitCode, null, '被信号杀掉时退出码就是 null');
  assert.strictEqual(outcome.timedOut, false, '「外部杀掉的」不是「我们超时杀的」，两者必须可区分');
  assert.strictEqual(outcome.truncated, false);
});

test('spawn 失败（ENOENT）：以 spawnError 回传而不是抛异常/炸宿主', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf());
  child.emitError(new Error('spawn ffmpeg ENOENT'));
  const outcome = await pending;

  assert.strictEqual(outcome.spawnError, 'spawn ffmpeg ENOENT', '启动失败原因必须原样回传');
  assert.strictEqual(outcome.exitCode, null, '没启动起来就没有退出码');
  assert.strictEqual(outcome.stdout.length, 0, '没启动起来就没有输出');
  assert.strictEqual(outcome.stderr, '', '没启动起来就没有 stderr');
  assert.strictEqual(outcome.timedOut, false, '启动失败 ≠ 超时');

  // 迟到的 close（真实进程在 error 之后通常也会 close）不得改写已交付的结论。
  child.emitClose(1);
  const again = await pending;
  assert.strictEqual(again.spawnError, 'spawn ffmpeg ENOENT', 'error 之后的 close 不得覆盖结论');
  assert.strictEqual(again.exitCode, null, 'error 之后的 close 不得把退出码塞进来');
});

test('stdout 截断：达到上限即停止累积，truncated 置真且总长不超上限', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf({ maxOutputBytes: 5 }));
  child.pushStdout(Buffer.from('abc')); // 3 字节，未越界
  child.pushStdout(Buffer.from('defg')); // 只剩 2 字节额度 ⇒ 只取 'de'
  child.pushStdout(Buffer.from('XY')); // 已到上限 ⇒ 整块丢弃（走「已越界」分支）
  child.emitClose(0);
  const outcome = await pending;

  assert.strictEqual(outcome.stdout.length, 5, '累积不得越界（继续 push 会看到 > 5）');
  assert.strictEqual(outcome.stdout.toString('utf8'), 'abcde', '越界的那一块被切成剩余额度');
  assert.strictEqual(
    outcome.truncated,
    true,
    '发生过丢弃就必须置 truncated，否则调用方会把残缺帧当完整帧',
  );
  assert.strictEqual(outcome.exitCode, 0, '截断只影响输出累积，进程照常跑到结束');
});

test('stdout 恰好填满上限：不算截断（边界在「超过」而不是「等于」）', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf({ maxOutputBytes: 5 }));
  child.pushStdout(Buffer.from('abcde'));
  child.emitClose(0);
  const outcome = await pending;

  assert.strictEqual(outcome.stdout.toString('utf8'), 'abcde', '恰好填满要全部留下');
  assert.strictEqual(outcome.truncated, false, '恰好填满不是截断——否则「完整帧」会被误标成残缺');
});

test('stdout 上限为 0：立即置 truncated 且一个字节都不收', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf({ maxOutputBytes: 0 }));
  child.pushStdout(Buffer.from('anything'));
  child.emitClose(0);
  const outcome = await pending;

  assert.strictEqual(outcome.stdout.length, 0, '上限 0 时不得收任何字节');
  assert.strictEqual(outcome.truncated, true, '有数据被丢弃就必须置 truncated');
});

test('stderr 有独立上限：截到 256 KiB，且不污染 stdout 的 truncated 标记', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf({ maxOutputBytes: 1024 }));
  child.pushStderr(Buffer.alloc(300 * 1024, 0x61)); // 300 KiB 的 'a'
  child.pushStderr(Buffer.from('tail')); // 已到上限 ⇒ 直接返回
  child.emitClose(0);
  const outcome = await pending;

  assert.strictEqual(outcome.stderr.length, EXPECTED_STDERR_LIMIT, 'stderr 必须被截到 256 KiB');
  assert.ok(outcome.stderr.startsWith('aaa'), '保留的是前段而不是后段');
  assert.strictEqual(outcome.stderr.includes('tail'), false, '越界后的内容一律不收');
  assert.strictEqual(outcome.stdout.length, 0, 'stderr 的数据不得混进 stdout');
  assert.strictEqual(
    outcome.truncated,
    false,
    '`truncated` 描述的是 stdout；stderr 被截不该让调用方以为抽帧结果残缺',
  );
});

test('超时：到点必须真杀（timedOut 置真、exitCode 为 null）', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);

  const pending = runner.run(requestOf({ timeoutMs: 40 }));
  assert.strictEqual(child.kills(), 0, '未到点前不得杀子进程');

  await delay(200);
  assert.strictEqual(child.kills(), 1, '到点必须杀掉子进程（只置标记不杀 = 静默挂死）');

  child.emitClose(null); // 真实进程被杀后也会 close
  const outcome = await pending;
  assert.strictEqual(outcome.timedOut, true, '超时必须如实回传');
  assert.strictEqual(outcome.exitCode, null, '被杀掉的进程退出码为 null');
  assert.strictEqual(outcome.spawnError, undefined, '超时不是启动失败');
});

test('取消（abort）：触发即杀，且与超时可区分', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);
  const controller = new AbortController();

  const pending = runner.run(requestOf({ timeoutMs: 5000, signal: controller.signal }));
  assert.strictEqual(child.kills(), 0, '未取消前不得杀');

  controller.abort();
  assert.strictEqual(child.kills(), 1, 'abort 必须立刻杀掉子进程');

  child.emitClose(null);
  const outcome = await pending;
  assert.strictEqual(outcome.timedOut, false, '取消不是超时——否则调用方会把用户取消报成超时');
  assert.strictEqual(outcome.exitCode, null, '被杀的进程退出码为 null');
  assert.strictEqual(outcome.spawnError, undefined, '取消不是启动失败');
});

test('收尾清理：正常结束后计时器与 abort 监听器都必须摘掉（否则会误杀/误报）', async () => {
  const child = new FakeMediaChild();
  const { spawn } = useFakeSpawn(child);
  const runner = new SpawnMediaProcessRunner(spawn);
  const controller = new AbortController();

  const pending = runner.run(requestOf({ timeoutMs: 40, signal: controller.signal }));
  child.emitClose(0);
  const outcome = await pending;
  assert.strictEqual(outcome.exitCode, 0, '夹具：先正常结束');

  // 越过原来的超时窗口：若 `clearTimeout(timer)` 漏了，这里会多出一次 kill。
  await delay(200);
  assert.strictEqual(
    child.kills(),
    0,
    '结束后计时器必须已清零（漏清会误杀一个早已结束的进程，并可能污染后续判定）',
  );

  // 结束后再取消：若 `removeEventListener` 漏了，取消信号会打在旧进程上。
  controller.abort();
  assert.strictEqual(child.kills(), 0, '结束后 abort 监听器必须已摘除');
  assert.strictEqual(outcome.timedOut, false, '清理动作不得改写已交付的结论');
});

test('缺省注入缝仍是真实的 node:child_process.spawn（不改被测行为的正对照）', async () => {
  // 刻意用一个**必然不存在**的可执行文件名：两种平台都只会得到 ENOENT，
  // 因此这条判据既不依赖本机装没装 ffmpeg，也能证明缺省缝接的是真 spawn 而不是桩。
  const runner = new SpawnMediaProcessRunner();
  const outcome = await runner.run(
    requestOf({
      command: 'omniharness-nonexistent-binary-for-unit-test',
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64,
    }),
  );

  assert.strictEqual(outcome.exitCode, null, '启动失败没有退出码');
  assert.notStrictEqual(
    outcome.spawnError,
    undefined,
    '真实 spawn 的 ENOENT 必须以 spawnError 回传',
  );
  assert.match(String(outcome.spawnError), /ENOENT/, '失败原因应含 ENOENT');
  assert.strictEqual(outcome.stdout.length, 0, '启动失败没有 stdout');
  assert.strictEqual(outcome.timedOut, false, '启动失败不是超时');
});
