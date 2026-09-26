/**
 * CLI worker 的**超时 / 取消**回归（2026-09-26 审计 X3/F3）。
 *
 * 缺陷现场：`WorkerRequest` 连 signal 字段都没有，`spawn` 后既不设超时也不在取消时终止子进程，
 * 而 `delegate` 在工具调度器里是**串行屏障** —— 一个挂死的 worker 会永久阻塞整个回合，
 * abort 后子进程还成孤儿（Windows 上孙进程一并存活）。
 *
 * 本用例用一个「只睡不返回」的 node 子进程触发两条路径，断言 `run()` 有界返回且如实报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliWorker } from '../../src/worker/cliWorker.js';

/** 只睡不返回的子进程（用本进程的 node 可执行文件，无需外部依赖）。 */
function sleeperWorker(timeoutMs: number): CliWorker {
  return new CliWorker({
    name: 'sleeper',
    command: process.execPath,
    args: () => ['-e', 'setTimeout(() => undefined, 60000)'],
    timeoutMs,
  });
}

test('X3：worker 超时必须有界返回 ok:false（不得永久阻塞串行屏障）', async () => {
  const worker = sleeperWorker(300);
  const started = Date.now();
  const result = await worker.run({ task: 'x', workspaceRoot: process.cwd() });
  const elapsed = Date.now() - started;
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /超时/, `应如实报告超时，实际输出：${result.output}`);
  assert.ok(elapsed < 10_000, `应在有界时间内返回，实际 ${String(elapsed)}ms`);
});

test('X3：会话取消必须终止 worker 并返回 ok:false', async () => {
  const worker = sleeperWorker(60_000);
  const controller = new AbortController();
  const running = worker.run({
    task: 'x',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
  });
  // 让子进程真正起来再取消。
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  const result = await running;
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /取消/, `应如实报告取消，实际输出：${result.output}`);
});

test('X3：构造时已取消的信号立即终止（不留孤儿）', async () => {
  const worker = sleeperWorker(60_000);
  const controller = new AbortController();
  controller.abort();
  const result = await worker.run({
    task: 'x',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /取消/);
});
