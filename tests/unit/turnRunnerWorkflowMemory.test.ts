import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnRunner } from '../../src/core/turnRunner.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { WorkflowMemoryStore } from '../../src/adapters/memory/workflowMemoryStore.ts';
import type { StepRunner } from '../../src/core/stepRunner.ts';

test('TurnRunner：成功回合自动沉淀 workflow，下一回合自动注入参考', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-turn-workflow-'));
  try {
    const store = new WorkflowMemoryStore(dir);
    const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 's1');
    recorder.user('修复登录鉴权失败');
    const stepRunner = {
      usageOfLastStep: 0,
      run: async () => {
        recorder.toolCall('c1', 'read_file', { path: 'src/auth.ts' });
        recorder.toolCall('c2', 'apply_patch', { patch: '***' });
        recorder.assistant('已修复');
        return 'text';
      },
      finalize: async () => '兜底',
    } as unknown as StepRunner;
    const runner = new TurnRunner(
      stepRunner,
      recorder,
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      store,
    );
    const context = { sessionId: 's1', workspaceRoot: dir };
    const first = await runner.run(context);
    assert.strictEqual(first.truncated, false);
    assert.strictEqual((await store.recall('登录鉴权')).length, 1, '成功回合应自动沉淀');

    await runner.run(context);
    const events = recorder.allEvents();
    assert.ok(
      events.some((event) => {
        if (event.type !== 'system') return false;
        const payload = event.payload as { readonly content?: unknown };
        return typeof payload.content === 'string' && payload.content.includes('[WorkflowMemory]');
      }),
      '第二回合应注入 WorkflowMemory 参考',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
