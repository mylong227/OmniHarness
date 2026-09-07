import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DshWorker } from '../../src/worker/dshWorker.js';
import { WorkerRegistry } from '../../src/worker/workerRegistry.js';
import { WorkerOrchestrator } from '../../src/worker/workerOrchestrator.js';

/** 真实二进制联调的前置条件：本机装有 dsh。 */
const dshReady = ((): boolean => {
  try {
    return spawnSync('dsh', ['-V'], { encoding: 'utf8', timeout: 30000, shell: true }).status === 0;
  } catch {
    return false;
  }
})();

/** 跳过原因（未装 dsh 时）。 */
const skipReason = dshReady ? false : '本机未安装 dsh，跳过真实二进制联调';

test(
  'dsh worker：真实二进制执行成功（配置转储，离线可跑）',
  { skip: skipReason, timeout: 120000 },
  async () => {
    const worker = DshWorker.inspect('web');
    const result = await worker.run({ task: '查看配置', workspaceRoot: process.cwd() });
    assert.strictEqual(result.ok, true, `期望成功，实际: ${result.output}`);
    assert.match(result.output, /dsh-base/, '输出应为 dsh 配置树');
    assert.ok(result.durationMs > 0);
  },
);

test(
  'dsh worker：真实二进制失败收敛为 ok:false（不抛异常）',
  { skip: skipReason, timeout: 120000 },
  async () => {
    const worker = DshWorker.inspect('omniharness-no-such-profile');
    const result = await worker.run({ task: '查看配置', workspaceRoot: process.cwd() });
    assert.strictEqual(result.ok, false);
    assert.ok(result.output.length > 0, '失败应有输出或错误信息');
  },
);

test(
  'dsh worker：经编排器调度真实二进制（一次调度跑通）',
  { skip: skipReason, timeout: 120000 },
  async () => {
    const registry = new WorkerRegistry();
    registry.register(DshWorker.inspect('web'));
    const orchestrator = new WorkerOrchestrator(registry);
    const result = await orchestrator.delegate(
      { worker: 'dsh-inspect:web', task: '查看配置' },
      process.cwd(),
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output, /dsh-base/);
  },
);
