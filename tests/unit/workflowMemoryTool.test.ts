import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowMemoryStore } from '../../src/adapters/memory/workflowMemoryStore.ts';
import { WorkflowMemoryTool } from '../../src/adapters/tool/memory/workflowMemoryTool.ts';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.ts';

/** 固定上下文。 */
const ctx = { sessionId: 's1', workspaceRoot: process.cwd() } as ToolContext;

/** 构造调用。 */
function call(action: string, task: string, steps?: readonly string[]): ToolCall {
  return {
    id: 'c1',
    name: 'workflow_memory',
    arguments: { action, task, ...(steps === undefined ? {} : { steps }) },
  };
}

test('workflow_memory：remember 后 recall 返回步骤；未知 action 拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-workflow-tool-'));
  try {
    const tool = new WorkflowMemoryTool(new WorkflowMemoryStore(dir));
    const remembered = await tool.handle(
      call('remember', '修复登录鉴权', ['read_file auth.ts', 'apply_patch']),
      ctx,
    );
    assert.strictEqual(remembered.ok, true, remembered.error);
    const recalled = await tool.handle(call('recall', '登录鉴权失败'), ctx);
    assert.strictEqual(recalled.ok, true);
    assert.match(recalled.output ?? '', /read_file auth\.ts/u);
    const bad = await tool.handle(call('unknown', 'x'), ctx);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /未知 action/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('workflow_memory：remember 缺步骤/空步骤拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-workflow-tool-bad-'));
  try {
    const tool = new WorkflowMemoryTool(new WorkflowMemoryStore(dir));
    const missing = await tool.handle(call('remember', 'x'), ctx);
    assert.strictEqual(missing.ok, false);
    const empty = await tool.handle(call('remember', 'x', [' ']), ctx);
    assert.strictEqual(empty.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
