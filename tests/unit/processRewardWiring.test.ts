import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfVerifyingToolPort } from '../../src/adapters/tool/verify/selfVerifyingToolPort.ts';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.ts';
import { ProcessRewardStore } from '../../src/adapters/memory/processRewardStore.ts';
import type { TestCommandRunner } from '../../src/adapters/tool/verify/testCommandRunner.ts';
import type { ToolCall, ToolContext, ToolPort, ToolResult } from '../../src/ports/tool/tool.ts';

/** 内层端口。 */
const inner: ToolPort = {
  name: 'inner',
  list: () => [],
  listDirect: () => [],
  execute: async (): Promise<ToolResult> => ({ callId: 'c1', ok: true, output: 'ok' }),
};

/** 第一次失败、第二次通过。 */
let run = 0;
const runner: TestCommandRunner = {
  run: async () => {
    run += 1;
    return run === 1
      ? { exitCode: 1, timedOut: false, output: 'AssertionError: boom' }
      : { exitCode: 0, timedOut: false, output: '' };
  },
};

/** 写源码调用。 */
const writeCall: ToolCall = {
  id: 'c1',
  name: 'write_file',
  arguments: { path: 'a.ts', content: 'export const x = 1;\n' },
} as unknown as ToolCall;

test('P3：自验证真实结果写入过程奖励账本（失败+通过）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reward-wiring-'));
  try {
    const rewards = new ProcessRewardStore(dir);
    const port = new SelfVerifyingToolPort(inner, {
      policy: SelfVerifyPolicy.from({
        command: 'node test.mjs',
        cooldownMs: 0,
        maxRunsPerSession: 10,
      }),
      workspaceRoot: dir,
      runner,
      shouldVerify: () => true,
      processRewards: rewards,
    });
    const ctx = { sessionId: 's1', workspaceRoot: dir } as unknown as ToolContext;
    await port.execute({ ...writeCall, id: 'c1' }, ctx);
    await port.execute({ ...writeCall, id: 'c2' }, ctx);
    const stats = await rewards.stats();
    assert.strictEqual(stats.samples, 2);
    assert.strictEqual(stats.passes, 1);
    assert.strictEqual(stats.passRate, 0.5);
    assert.strictEqual(stats.withNoul, 0);
    assert.strictEqual(await rewards.predict('write_file'), 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
