import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfVerifyingToolPort } from '../../src/adapters/tool/verify/selfVerifyingToolPort.ts';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.ts';
import { FailureReflectionStore } from '../../src/adapters/memory/failureReflectionStore.ts';
import type { TestCommandRunner } from '../../src/adapters/tool/verify/testCommandRunner.ts';
import type { ToolPort, ToolCall, ToolContext, ToolResult } from '../../src/ports/tool/tool.ts';

/** 内层工具：只回 ok，真实写盘由测试夹具模拟。 */
const inner: ToolPort = {
  name: 'stub-inner',
  list: () => [],
  listDirect: () => [],
  unregister: () => false,
  execute: async (): Promise<ToolResult> => ({ callId: 'c1', ok: true, output: 'ok' }),
};

/** 恒失败的测试执行器。 */
const failingRunner: TestCommandRunner = {
  run: async () => ({
    exitCode: 1,
    timedOut: false,
    output: 'AssertionError [ERR_ASSERTION]: expected 1 to equal 2\n  at a.ts:3:1',
  }),
};

/** 写源码调用（MutationTargets 能识别的重要形状）。 */
const writeCall: ToolCall = {
  id: 'c1',
  name: 'write_file',
  arguments: { path: 'a.ts', content: 'export const x = 1;\n' },
} as unknown as ToolCall;

test('失败反思：第一次失败写盘，第二次写同一目标前回灌历史教训', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reflection-wiring-'));
  try {
    const policy = SelfVerifyPolicy.from({
      command: 'node test.mjs',
      cooldownMs: 0,
      maxRunsPerSession: 10,
    });
    const port = new SelfVerifyingToolPort(inner, {
      policy,
      workspaceRoot: dir,
      runner: failingRunner,
      shouldVerify: () => true,
      reflections: new FailureReflectionStore(dir),
    });
    const ctx = { sessionId: 's1', workspaceRoot: dir } as unknown as ToolContext;

    const first = await port.execute(writeCall, ctx);
    assert.strictEqual(first.ok, true);
    assert.match(first.output ?? '', /自验证回环/u);
    assert.doesNotMatch(first.output ?? '', /历史失败反思/u);

    const second = await port.execute({ ...writeCall, id: 'c2' }, ctx);
    assert.strictEqual(second.ok, true);
    assert.match(second.output ?? '', /\[历史失败反思\]/u);
    assert.match(second.output ?? '', /a\.ts/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
