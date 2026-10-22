import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { TodoWriteTool, TodoReadTool } from '../../src/adapters/tool/plan/todoTool.ts';
import { AskUserTool } from '../../src/adapters/tool/plan/askUserTool.ts';
import {
  PlanWriteTool,
  PlanPresentTool,
  PlanReadTool,
} from '../../src/adapters/tool/plan/planTool.ts';
import { MemoryTodo } from '../../src/adapters/todo/memoryTodo.ts';
import { MemoryPlan } from '../../src/adapters/plan/memoryPlan.ts';
import { MemoryUserResponder } from '../../src/adapters/user/memoryUserResponder.ts';
import { DefaultUserResponder } from '../../src/adapters/user/defaultUserResponder.ts';
import { ToolGate } from '../../src/core/toolGate.ts';
import { eventFactory } from '../../src/core/eventFactory.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.ts';
import type { AskAnswer } from '../../src/ports/runtime/userResponder.ts';

const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
});

describe('TodoTool', () => {
  it('整表写入后可读回快照', async () => {
    const port = new MemoryTodo();
    const writer = new TodoWriteTool(port, undefined, eventFactory);
    const r = await writer.handle(
      call('todo_write', {
        todos: [
          { content: 'A', status: 'in_progress' },
          { content: 'B', status: 'pending' },
        ],
      }),
      ctx,
    );
    assert.strictEqual(r.ok, true);
    const read = await new TodoReadTool(port).handle(call('todo_read', {}), ctx);
    const items = JSON.parse(read.output ?? '[]') as { content: string; status: string }[];
    assert.strictEqual(items.length, 2);
    const first = items[0];
    assert.ok(first !== undefined, '应有第一条待办');
    assert.strictEqual(first.content, 'A');
    assert.strictEqual(first.status, 'in_progress');
  });

  it('空 content 校验拒绝', async () => {
    const r = await new TodoWriteTool(new MemoryTodo(), undefined, eventFactory).handle(
      call('todo_write', { todos: [{ content: '', status: 'pending' }] }),
      ctx,
    );
    assert.strictEqual(r.ok, false);
  });

  it('非法 status 校验拒绝', async () => {
    const r = await new TodoWriteTool(new MemoryTodo(), undefined, eventFactory).handle(
      call('todo_write', { todos: [{ content: 'A', status: 'bogus' }] }),
      ctx,
    );
    assert.strictEqual(r.ok, false);
  });

  it('同一时刻多条 in_progress 被拒绝（防止计划状态自相矛盾）', async () => {
    const r = await new TodoWriteTool(new MemoryTodo(), undefined, eventFactory).handle(
      call('todo_write', {
        todos: [
          { content: 'A', status: 'in_progress' },
          { content: 'B', status: 'in_progress' },
        ],
      }),
      ctx,
    );
    assert.strictEqual(r.ok, false);
    assert.match(r.error ?? '', /最多.*in_progress/u);
  });

  it('超过 20 条待办被拒绝（避免噪声塞爆 UI/上下文）', async () => {
    const todos = Array.from({ length: 21 }, (_, i) => ({
      content: `T${String(i)}`,
      status: 'pending',
    }));
    const r = await new TodoWriteTool(new MemoryTodo(), undefined, eventFactory).handle(
      call('todo_write', { todos }),
      ctx,
    );
    assert.strictEqual(r.ok, false);
    assert.match(r.error ?? '', /最多 20 条/u);
  });

  it('带依赖的有向无环计划可写入并读回 id/dependsOn', async () => {
    const port = new MemoryTodo();
    const writer = new TodoWriteTool(port, undefined, eventFactory);
    const r = await writer.handle(
      call('todo_write', {
        todos: [
          { id: 'inspect', content: '读代码', status: 'completed' },
          { id: 'edit', content: '改代码', status: 'in_progress', dependsOn: ['inspect'] },
          { id: 'test', content: '跑测试', status: 'pending', dependsOn: ['edit'] },
        ],
      }),
      ctx,
    );
    assert.strictEqual(r.ok, true, r.error);
    const read = await new TodoReadTool(port).handle(call('todo_read', {}), ctx);
    const items = JSON.parse(read.output ?? '[]') as { dependsOn?: string[] }[];
    assert.deepStrictEqual(items[1]?.dependsOn, ['inspect']);
    assert.deepStrictEqual(items[2]?.dependsOn, ['edit']);
  });

  it('悬空依赖 / 重复 id / 依赖环一律拒绝', async () => {
    const writer = new TodoWriteTool(new MemoryTodo(), undefined, eventFactory);
    const missing = await writer.handle(
      call('todo_write', {
        todos: [{ id: 'a', content: 'A', status: 'pending', dependsOn: ['nope'] }],
      }),
      ctx,
    );
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error ?? '', /不存在/u);

    const duplicate = await writer.handle(
      call('todo_write', {
        todos: [
          { id: 'a', content: 'A', status: 'pending' },
          { id: 'a', content: 'B', status: 'pending' },
        ],
      }),
      ctx,
    );
    assert.strictEqual(duplicate.ok, false);
    assert.match(duplicate.error ?? '', /重复/u);

    const cycle = await writer.handle(
      call('todo_write', {
        todos: [
          { id: 'a', content: 'A', status: 'pending', dependsOn: ['b'] },
          { id: 'b', content: 'B', status: 'pending', dependsOn: ['a'] },
        ],
      }),
      ctx,
    );
    assert.strictEqual(cycle.ok, false);
    assert.match(cycle.error ?? '', /环/u);
  });
});

describe('AskUserTool', () => {
  it('注入式回答器回传答案', async () => {
    const answers = new Map<string, AskAnswer>([['q1', { id: 'q1', selected: ['approve'] }]]);
    const tool = new AskUserTool(new MemoryUserResponder(answers), undefined, eventFactory);
    const r = await tool.handle(
      call('ask_user', {
        questions: [{ id: 'q1', question: '可以吗？', options: [{ label: 'approve' }] }],
      }),
      ctx,
    );
    assert.strictEqual(r.ok, true);
    const parsed = JSON.parse(r.output ?? '{}') as { answers: AskAnswer[] };
    const a0 = parsed.answers[0];
    assert.ok(a0 !== undefined, '应有答案');
    assert.strictEqual(a0.id, 'q1');
    assert.deepStrictEqual(a0.selected, ['approve']);
  });

  it('无人值守默认回答器 fail-soft 返回说明', async () => {
    const r = await new AskUserTool(new DefaultUserResponder(), undefined, eventFactory).handle(
      call('ask_user', { questions: [{ id: 'q1', question: '?' }] }),
      ctx,
    );
    const parsed = JSON.parse(r.output ?? '{}') as { answers: AskAnswer[] };
    const a0 = parsed.answers[0];
    assert.ok(a0 !== undefined, '应有答案');
    assert.strictEqual(a0.selected.length, 0);
    assert.match(a0.custom ?? '', /未配置交互式用户回答/);
  });

  it('questions 非空校验', async () => {
    const r = await new AskUserTool(new DefaultUserResponder(), undefined, eventFactory).handle(
      call('ask_user', { questions: [] }),
      ctx,
    );
    assert.strictEqual(r.ok, false);
  });
});

describe('PlanTool + 计划门禁', () => {
  it('write→present(approve)→状态 approved', async () => {
    const plan = new MemoryPlan();
    const responder = new MemoryUserResponder(
      new Map([['plan_decision', { id: 'plan_decision', selected: ['approve'] }]]),
    );
    const write = new PlanWriteTool(plan, undefined, eventFactory);
    const present = new PlanPresentTool(plan, responder, undefined, eventFactory);
    const w = await write.handle(
      call('plan_write', { title: 'T', steps: [{ description: '做 X' }] }),
      ctx,
    );
    assert.strictEqual(w.ok, true);
    const p = await present.handle(call('plan_present', {}), ctx);
    assert.match(p.output ?? '', /批准/);
    assert.strictEqual(plan.get()?.status, 'approved');
  });

  it('present(reject)→状态 rejected', async () => {
    const plan = new MemoryPlan();
    const responder = new MemoryUserResponder(
      new Map([['plan_decision', { id: 'plan_decision', selected: ['reject'] }]]),
    );
    await new PlanWriteTool(plan, undefined, eventFactory).handle(
      call('plan_write', { steps: [{ description: '做 X' }] }),
      ctx,
    );
    const p = await new PlanPresentTool(plan, responder, undefined, eventFactory).handle(
      call('plan_present', {}),
      ctx,
    );
    assert.match(p.output ?? '', /驳回/);
    assert.strictEqual(plan.get()?.status, 'rejected');
  });

  it('无计划时 present 报错', async () => {
    const r = await new PlanPresentTool(
      new MemoryPlan(),
      new DefaultUserResponder(),
      undefined,
      eventFactory,
    ).handle(call('plan_present', {}), ctx);
    assert.strictEqual(r.ok, false);
  });

  it('计划门禁：未批准拦截写类工具，批准后放行', async () => {
    const plan = new MemoryPlan();
    const gate = new ToolGate(new AutoApproval(), new PassthroughSandbox(), plan, true);
    // 未写计划 → 拦截
    let denied = await gate.gate(call('shell', { command: 'ls' }), 's1');
    assert.notStrictEqual(denied, undefined, '无计划应被拦截');
    // 写计划但未批准 → 仍拦截
    await new PlanWriteTool(plan, undefined, eventFactory).handle(
      call('plan_write', { steps: [{ description: 'X' }] }),
      ctx,
    );
    denied = await gate.gate(call('write_file', { path: 'a' }), 's1');
    assert.notStrictEqual(denied, undefined, 'drafting 应被拦截');
    // 批准 → 放行
    const responder = new MemoryUserResponder(
      new Map([['plan_decision', { id: 'plan_decision', selected: ['approve'] }]]),
    );
    await new PlanPresentTool(plan, responder, undefined, eventFactory).handle(
      call('plan_present', {}),
      ctx,
    );
    denied = await gate.gate(call('shell', { command: 'ls' }), 's1');
    assert.strictEqual(denied, undefined, 'approved 后放行');
  });

  it('计划门禁：非写类工具（read_file/ask_user/plan_write）不受限', async () => {
    const plan = new MemoryPlan();
    const gate = new ToolGate(new AutoApproval(), new PassthroughSandbox(), plan, true);
    assert.strictEqual(await gate.gate(call('read_file', { path: 'a' }), 's1'), undefined);
    assert.strictEqual(await gate.gate(call('ask_user', { questions: [] }), 's1'), undefined);
    assert.strictEqual(await gate.gate(call('plan_write', { steps: [] }), 's1'), undefined);
  });

  it('planMode 关闭时门禁不生效', async () => {
    const plan = new MemoryPlan();
    const gate = new ToolGate(new AutoApproval(), new PassthroughSandbox(), plan, false);
    assert.strictEqual(await gate.gate(call('shell', { command: 'ls' }), 's1'), undefined);
  });

  it('plan_read 无计划返回提示', async () => {
    const r = await new PlanReadTool(new MemoryPlan()).handle(call('plan_read', {}), ctx);
    assert.match(r.output ?? '', /尚无计划/);
  });
});
