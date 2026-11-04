/**
 * `run_plan` 工具判据（2026-11-04 覆盖率补测，原 22.93% 全为间接覆盖）。
 *
 * 钉死的口径：空计划 fail-closed、依赖图的环 / 未知依赖 / 重复 id 由 WorkflowRunner
 * 的规格校验同步抛出并**透传为 ok:false 的可读错误**。
 *
 * 诚实边界：成功执行路径需要全量 `SubagentPortsShape` 替身去驱动 737 行的真实工作流引擎
 * （含持久化日志），超出补测站的比例——该路径由 agentLoop 族判据间接覆盖，不在此重复造假桩。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunPlanTool } from '../../src/kernel/adapters/tool/workflow/runPlanTool.ts';
import { MemoryTodo } from '../../src/kernel/adapters/todo/memoryTodo.ts';
import { eventFactory } from '../../src/kernel/core/eventFactory.ts';
import type { SubagentPortsShape } from '../../src/contracts/ports/subagent/subagentPortsShape.ts';
import type { TodoItem, TodoPort } from '../../src/contracts/ports/runtime/todo.ts';
import type { ToolCall, ToolContext } from '../../src/contracts/ports/tool/tool.ts';

const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
});

/** 死端口束（本判据只走规格校验与空计划路径，端口不被触达）。 */
function deadPorts(): SubagentPortsShape {
  return {
    workspaceRoot: mkdtempSync(join(tmpdir(), 'omni-runplan-')),
  } as unknown as SubagentPortsShape;
}

/** 造一个带既定项的 MemoryTodo。 */
function todoWith(items: readonly Partial<TodoItem>[]): TodoPort {
  const port = new MemoryTodo();
  port.snapshot(
    items.map((item, index) => ({
      content: item.content ?? `步骤${String(index + 1)}`,
      status: item.status ?? 'pending',
      ...(item.id !== undefined ? { id: item.id } : {}),
      ...(item.dependsOn !== undefined ? { dependsOn: item.dependsOn } : {}),
    })) as TodoItem[],
    's1',
  );
  return port;
}

test('① 空计划 fail-closed：全部 completed ⇒ ok:false 且不触引擎', async () => {
  const tool = new RunPlanTool(
    deadPorts(),
    todoWith([{ status: 'completed' }]),
    undefined,
    eventFactory,
  );
  const result = await tool.handle(call('run_plan', {}), ctx);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /没有未完成的 todo 步骤/u);
});

test('② 环：a↔b 互为依赖 ⇒ 规格校验同步抛出，透传为可读错误', async () => {
  const tool = new RunPlanTool(
    deadPorts(),
    todoWith([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]),
    undefined,
    eventFactory,
  );
  const result = await tool.handle(call('run_plan', {}), ctx);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /(环|cycle|依赖)/iu);
});

test('③ 未知依赖：dependsOn 指向不存在的 id ⇒ 可读错误并列出可用步骤', async () => {
  const tool = new RunPlanTool(
    deadPorts(),
    todoWith([{ id: 'a', dependsOn: ['ghost'] }]),
    undefined,
    eventFactory,
  );
  const result = await tool.handle(call('run_plan', {}), ctx);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /ghost/u);
});

test('④ 重复 id：两个同 id 步骤 ⇒ 「步骤 id 重复」', async () => {
  const tool = new RunPlanTool(
    deadPorts(),
    todoWith([{ id: 'a' }, { id: 'a' }]),
    undefined,
    eventFactory,
  );
  const result = await tool.handle(call('run_plan', {}), ctx);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /重复/u);
});
