/**
 * shell 会话公平闸门判据：多会话并发 shell 时总量有界、分配公平、排队可取消。
 *
 * 旧实现没有全局 shell 闸门：N 个会话可以同时起任意多子进程，把机器 CPU/句柄打满，
 * 最先到的会话反而可能因为系统抖动拿不到结果。本文件用假 runner 精确观测并发峰值，
 * 不依赖真实子进程（判据本身要确定性）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellTool } from '../../src/adapters/tool/shell/shellTool.ts';
import type { ShellRunOutcome } from '../../src/adapters/tool/shell/shellProcessRunner.ts';
import { FairSessionScheduler } from '../../src/util/concurrency/fairSessionScheduler.ts';

/** 成功结果（无输出内容对判据无影响）。 */
const OK: ShellRunOutcome = {
  stdout: Buffer.from('ok\n'),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  signal: null,
  timedOut: false,
  overflowed: false,
  aborted: false,
};

/** 可手动释放的假 runner（记录峰值并发与启动顺序）。 */
function fakeRunner(): {
  readonly run: (command: string) => Promise<ShellRunOutcome>;
  readonly active: () => number;
  readonly peak: () => number;
  readonly release: () => void;
  readonly started: () => number;
  readonly startedCommands: () => readonly string[];
} {
  let active = 0;
  let peak = 0;
  let started = 0;
  const commands: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    run: async (command: string) => {
      active += 1;
      started += 1;
      commands.push(command);
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return OK;
    },
    active: () => active,
    peak: () => peak,
    release: () => release(),
    started: () => started,
    startedCommands: () => commands,
  };
}

/** 等到条件成立（有界轮询）。 */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 在临时工作区内执行。 */
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shell-governor-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('① 总量有界：limit=1 时两个会话的 shell 不会同时执行', async () => {
  await withTemp(async (dir) => {
    const runner = fakeRunner();
    const tool = new ShellTool({
      runner,
      governor: new FairSessionScheduler({ limit: 1 }),
    });
    const first = tool.handle(
      { id: 'c1', name: 'shell', arguments: { command: 'echo A' } },
      { sessionId: 'A', workspaceRoot: dir },
    );
    await until(() => runner.active() === 1);
    const second = tool.handle(
      { id: 'c2', name: 'shell', arguments: { command: 'echo B' } },
      { sessionId: 'B', workspaceRoot: dir },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(runner.peak(), 1, `并发峰值必须 ≤1（实测 ${String(runner.peak())}）`);
    runner.release();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
  });
});

test('② 会话公平：A 排队 5 条时，B 的第一条不会排在 A 的第 5 条之后', async () => {
  await withTemp(async (dir) => {
    const runner = fakeRunner();
    const tool = new ShellTool({
      runner,
      governor: new FairSessionScheduler({ limit: 1 }),
    });
    const calls = [
      tool.handle(
        { id: 'a1', name: 'shell', arguments: { command: 'echo A1' } },
        { sessionId: 'A', workspaceRoot: dir },
      ),
      tool.handle(
        { id: 'a2', name: 'shell', arguments: { command: 'echo A2' } },
        { sessionId: 'A', workspaceRoot: dir },
      ),
      tool.handle(
        { id: 'a3', name: 'shell', arguments: { command: 'echo A3' } },
        { sessionId: 'A', workspaceRoot: dir },
      ),
      tool.handle(
        { id: 'a4', name: 'shell', arguments: { command: 'echo A4' } },
        { sessionId: 'A', workspaceRoot: dir },
      ),
      tool.handle(
        { id: 'a5', name: 'shell', arguments: { command: 'echo A5' } },
        { sessionId: 'A', workspaceRoot: dir },
      ),
      tool.handle(
        { id: 'b1', name: 'shell', arguments: { command: 'echo B1' } },
        { sessionId: 'B', workspaceRoot: dir },
      ),
    ];
    await until(() => runner.started() === 1);
    runner.release();
    const results = await Promise.all(calls);
    assert.strictEqual(
      results.every((result) => result.ok),
      true,
    );
    const order = runner.startedCommands();
    const b1 = order.indexOf('echo B1');
    const a5 = order.indexOf('echo A5');
    assert.ok(b1 >= 0 && a5 >= 0, `六条命令都必须执行（实际顺序 ${order.join(' → ')}）`);
    assert.ok(b1 < a5, `B 的第一条不得排在 A 的第五条之后（实际顺序 ${order.join(' → ')}）`);
    assert.strictEqual(runner.peak(), 1);
  });
});

test('③ 队列满：单会话排队超限 ⇒ 工具返回可读失败，不无限挂起', async () => {
  await withTemp(async (dir) => {
    const runner = fakeRunner();
    const tool = new ShellTool({
      runner,
      governor: new FairSessionScheduler({ limit: 1, maxQueuePerSession: 1 }),
    });
    const active = tool.handle(
      { id: 'a1', name: 'shell', arguments: { command: 'echo A1' } },
      { sessionId: 'A', workspaceRoot: dir },
    );
    await until(() => runner.active() === 1);
    const queued = tool.handle(
      { id: 'a2', name: 'shell', arguments: { command: 'echo A2' } },
      { sessionId: 'A', workspaceRoot: dir },
    );
    const rejected = await tool.handle(
      { id: 'a3', name: 'shell', arguments: { command: 'echo A3' } },
      { sessionId: 'A', workspaceRoot: dir },
    );
    assert.strictEqual(rejected.ok, false);
    assert.match(rejected.error ?? '', /排队任务已达上限/);
    runner.release();
    await Promise.all([active, queued]);
  });
});

test('④ 排队取消：已排队未执行的 shell 被取消后返回失败，不占用槽位', async () => {
  await withTemp(async (dir) => {
    const runner = fakeRunner();
    const tool = new ShellTool({
      runner,
      governor: new FairSessionScheduler({ limit: 1 }),
    });
    const active = tool.handle(
      { id: 'a1', name: 'shell', arguments: { command: 'echo A1' } },
      { sessionId: 'A', workspaceRoot: dir },
    );
    await until(() => runner.active() === 1);
    const controller = new AbortController();
    const queued = tool.handle(
      { id: 'b1', name: 'shell', arguments: { command: 'echo B1' } },
      { sessionId: 'B', workspaceRoot: dir, signal: controller.signal },
    );
    controller.abort();
    const result = await queued;
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /取消/);
    runner.release();
    assert.strictEqual((await active).ok, true);
    assert.strictEqual(runner.started(), 1, '被取消的命令不得真正执行');
  });
});

test('⑤ 未注入闸门：保持原有立即并行语义（零行为变更）', async () => {
  await withTemp(async (dir) => {
    const runner = fakeRunner();
    const tool = new ShellTool({ runner });
    const first = tool.handle(
      { id: 'c1', name: 'shell', arguments: { command: 'echo A' } },
      { sessionId: 'A', workspaceRoot: dir },
    );
    const second = tool.handle(
      { id: 'c2', name: 'shell', arguments: { command: 'echo B' } },
      { sessionId: 'B', workspaceRoot: dir },
    );
    await until(() => runner.active() === 2);
    assert.strictEqual(runner.peak(), 2);
    runner.release();
    await Promise.all([first, second]);
  });
});
