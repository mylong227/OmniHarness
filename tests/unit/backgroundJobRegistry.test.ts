/**
 * 后台作业注册表与 shell_job 工具单测（P2-⑫）。
 *
 * 只跑**跨平台、无路径依赖**的命令（`echo` / `ping`），避免把本机 node 路径写进用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundJobRegistry } from '../../src/adapters/tool/shell/backgroundJobRegistry.js';
import { ShellJobTool } from '../../src/adapters/tool/shell/shellJobTool.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/**
 * 轮询等待条件成立。
 *
 * @param predicate 条件（返回 true 即结束等待）。
 * @param timeoutMs 超时毫秒数。
 * @returns 条件是否在超时前成立。
 */
const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

/** 工具上下文（shell_job 不依赖工作区）。 */
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: '/repo' };

test('后台命令：输出落日志、状态可查、清单可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgjob-'));
  try {
    const registry = new BackgroundJobRegistry(dir);
    const job = registry.start('echo bg-ok', process.env);
    assert.strictEqual(job.id, 'bg-1');
    assert.strictEqual(job.status, 'running');

    const finished = await waitFor(() => registry.status('bg-1')?.status !== 'running');
    assert.strictEqual(finished, true, '作业应在超时前结束');
    assert.strictEqual(registry.status('bg-1')?.status, 'exited');
    assert.strictEqual(registry.status('bg-1')?.exitCode, 0);
    assert.ok((registry.output('bg-1', 4096) ?? '').includes('bg-ok'));
    assert.strictEqual(registry.list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未知作业 id：output/status/kill 都不得抛错且给出明确结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgjob-'));
  try {
    const registry = new BackgroundJobRegistry(dir);
    assert.strictEqual(registry.output('bg-404', 100), undefined);
    assert.strictEqual(registry.status('bg-404'), undefined);
    assert.strictEqual(registry.kill('bg-404'), false);
    assert.deepStrictEqual([...registry.list()], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('kill 能终止仍在运行的作业（ping 作慢命令，stdin-agnostic）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgjob-'));
  try {
    const registry = new BackgroundJobRegistry(dir);
    registry.start('ping -n 6 127.0.0.1', process.env);
    assert.strictEqual(registry.kill('bg-1'), true);
    assert.strictEqual(registry.status('bg-1')?.status, 'killed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell_job：list / status / output / kill 与参数校验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgjob-'));
  try {
    const registry = new BackgroundJobRegistry(dir);
    const tool = new ShellJobTool(registry);

    const emptyList = await tool.handle(
      { id: 'c0', name: 'shell_job', arguments: { action: 'list' } },
      ctx,
    );
    assert.ok(emptyList.output?.includes('没有后台作业'));

    registry.start('echo job-out', process.env);
    await waitFor(() => registry.status('bg-1')?.status !== 'running');

    const list = await tool.handle(
      { id: 'c1', name: 'shell_job', arguments: { action: 'list' } },
      ctx,
    );
    assert.ok(list.output?.includes('bg-1'));

    const status = await tool.handle(
      { id: 'c2', name: 'shell_job', arguments: { action: 'status', id: 'bg-1' } },
      ctx,
    );
    assert.ok(status.output?.includes('exited'));

    const output = await tool.handle(
      { id: 'c3', name: 'shell_job', arguments: { action: 'output', id: 'bg-1' } },
      ctx,
    );
    assert.ok(output.output?.includes('job-out'));

    const missingId = await tool.handle(
      { id: 'c4', name: 'shell_job', arguments: { action: 'kill' } },
      ctx,
    );
    assert.strictEqual(missingId.ok, false);
    assert.ok(missingId.error?.includes('需要 id'));

    const badAction = await tool.handle(
      { id: 'c5', name: 'shell_job', arguments: { action: 'explode', id: 'bg-1' } },
      ctx,
    );
    assert.strictEqual(badAction.ok, false);
    assert.ok(badAction.error?.includes('未知 action'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
