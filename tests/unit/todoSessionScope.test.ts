/**
 * 待办端口的**会话隔离**回归（2026-09-26 审计 F7/F9）。
 *
 * 缺陷现场：`MemoryTodo` 在组合根是**进程级单例**，而待办工具在注册期就闭包捕获了它。
 * 改造前只有一张整表 ⇒
 *  - F7：长跑 server 上所有会话（含 Web 多线程）共用同一份待办，「会话级 last-write-wins」不成立；
 *  - F9：子代理的 `todo_write` 会把**父会话**的清单整表覆盖并向父事件流发通知
 *    （子代 runtime 自建的那份端口从未绑定任何工具，是死对象）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryTodo } from '../../src/adapters/todo/memoryTodo.js';
import { TodoWriteTool } from '../../src/adapters/tool/plan/todoWriteTool.js';
import { TodoReadTool } from '../../src/adapters/tool/plan/todoReadTool.js';
import type { TodoItem } from '../../src/ports/runtime/todo.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';
import { EventFactory } from '../../src/core/eventFactory.js';

/** 构造工具上下文（只用到 sessionId）。 */
function ctxOf(sessionId: string): ToolContext {
  return { sessionId, workspaceRoot: process.cwd() } as ToolContext;
}

/** 构造 todo_write 调用。 */
function writeCall(items: readonly TodoItem[]): ToolCall {
  return { id: 'c1', name: 'todo_write', arguments: { todos: [...items] } };
}

const THREE: readonly TodoItem[] = [
  { content: '甲', status: 'pending' },
  { content: '乙', status: 'in_progress' },
  { content: '丙', status: 'completed' },
];

test('F7：按会话分桶——两个会话各写各的，互不覆盖', () => {
  const port = new MemoryTodo();
  port.snapshot(THREE, 's1');
  port.snapshot([{ content: '子任务', status: 'pending' }], 's2');
  assert.deepStrictEqual(port.list('s1'), THREE, 's1 的清单不得被 s2 覆盖');
  assert.deepStrictEqual(port.list('s2'), [{ content: '子任务', status: 'pending' }]);
  assert.deepStrictEqual(port.list('never-seen'), [], '未写过的会话为空');
});

test('F7：无 sessionId 的调用走全局桶（库调用方旧行为不变）', () => {
  const port = new MemoryTodo();
  port.snapshot(THREE);
  assert.deepStrictEqual(port.list(), THREE);
  assert.deepStrictEqual(port.list('s1'), [], '全局桶与会话桶互不串味');
});

test('F9：子代理 todo_write 不得覆盖父会话待办（工具层端到端）', async () => {
  const port = new MemoryTodo();
  const writer = new TodoWriteTool(port, undefined, new EventFactory());
  const reader = new TodoReadTool(port);
  // 父会话写 3 条。
  await writer.handle(writeCall(THREE), ctxOf('parent'));
  // 子代理（独立 sessionId）写 1 条。
  await writer.handle(writeCall([{ content: '子任务', status: 'in_progress' }]), ctxOf('child'));
  const seen = await reader.handle({ id: 'r1', name: 'todo_read', arguments: {} }, ctxOf('parent'));
  assert.deepStrictEqual(
    JSON.parse(seen.output ?? '[]'),
    THREE,
    '父会话读回的必须是自己的 3 条（旧实现被子代理整表覆盖成 1 条）',
  );
});

test('F7：会话桶有界（不超过上限，且最早登记的会话被淘汰）', () => {
  const port = new MemoryTodo();
  for (let i = 0; i <= MemoryTodo.MAX_SESSIONS; i += 1) {
    port.snapshot([{ content: `t${String(i)}`, status: 'pending' }], `s${String(i)}`);
  }
  assert.deepStrictEqual(port.list('s0'), [], '最早登记的会话桶应被淘汰');
  assert.strictEqual(
    port.list(`s${String(MemoryTodo.MAX_SESSIONS)}`).length,
    1,
    '最新登记的会话桶必须保留',
  );
});
