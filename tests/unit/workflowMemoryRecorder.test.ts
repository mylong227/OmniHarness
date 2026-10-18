import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowMemoryStore } from '../../src/adapters/memory/workflowMemoryStore.ts';
import { WorkflowMemoryRecorder } from '../../src/core/workflowMemoryRecorder.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

/** 造一个 user 事件。 */
function user(content: string): SessionEvent {
  return {
    id: 'e1',
    type: 'user',
    sessionId: 's1',
    timestamp: '',
    payload: { content },
  } as SessionEvent;
}

/** 造一个 tool_call 事件。 */
function tool(name: string, args: Record<string, unknown>): SessionEvent {
  return {
    id: 'e2',
    type: 'tool_call',
    sessionId: 's1',
    timestamp: '',
    payload: { name, args },
  } as SessionEvent;
}

test('WorkflowMemoryRecorder：taskOf 取最后 user；capture 只记成功且 ≥2 步', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-wm-recorder-'));
  try {
    const store = new WorkflowMemoryStore(dir);
    const recorder = new WorkflowMemoryRecorder(store);
    const events = [
      user('修复登录鉴权'),
      tool('read_file', { path: 'a.ts' }),
      tool('apply_patch', {}),
    ];
    assert.strictEqual(WorkflowMemoryRecorder.taskOf(events), '修复登录鉴权');
    await recorder.capture('修复登录鉴权', events, true);
    assert.strictEqual((await store.recall('登录鉴权')).length, 1);
    await recorder.capture('另一次', events, false);
    assert.strictEqual((await store.recall('另一次')).length, 0);
    const primed = await recorder.prime('登录鉴权');
    assert.match(primed ?? '', /WorkflowMemory/u);
    assert.doesNotMatch(primed ?? '', /原始输出/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
