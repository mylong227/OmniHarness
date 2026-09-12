import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TodoWriteTool, TodoReadTool } from '../../src/adapters/tool/todoTool.js';
import { AskUserTool } from '../../src/adapters/tool/askUserTool.js';
import { PlanWriteTool, PlanPresentTool, PlanReadTool } from '../../src/adapters/tool/planTool.js';
import { MemoryTodo } from '../../src/adapters/todo/memoryTodo.js';
import { MemoryPlan } from '../../src/adapters/plan/memoryPlan.js';
import { MemoryUserResponder } from '../../src/adapters/user/memoryUserResponder.js';
import { DefaultUserResponder } from '../../src/adapters/user/defaultUserResponder.js';
import { ToolGate } from '../../src/core/toolGate.js';
import { eventFactory } from '../../src/core/eventFactory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool.js';
import type { AskAnswer } from '../../src/ports/userResponder.js';

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
