/**
 * 计划进度回填不得把自己锁死（2026-09-26 审计 F14）。
 *
 * 缺陷现场：唯一的进度回填途径就是再次 `plan_write`（没有增量工具），而 `MemoryPlan.write`
 * 一律把状态回落 `drafting` ⇒ **汇报一次进度就把全部写类工具重新锁死**（ToolGate 对写类工具
 * 要求 `status === 'approved'`），要等用户再点一次审批才能继续。
 *
 * 修法：计划已 `approved` 且本次草稿的**步骤集合逐字未变**（只有 status 回填等差异）时保持
 * approved；步骤集合变化（增删/改写描述）仍回落 drafting 并要求重新审批。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryPlan } from '../../src/adapters/plan/memoryPlan.js';
import { PlanWriteTool } from '../../src/adapters/tool/plan/planWriteTool.js';
import { ToolGate } from '../../src/core/toolGate.js';
import type { ToolCall } from '../../src/ports/tool/tool.js';
import type { ApprovalPort } from '../../src/ports/runtime/approval.js';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.js';

/** 放行一切的工具上下文桩（只用到 sessionId）。 */
const ctx = { sessionId: 's1', workspaceRoot: process.cwd() } as never;

test('F14：已批准计划回填 step 进度后仍保持 approved', () => {
  const plan = new MemoryPlan();
  plan.write({ steps: [{ description: '甲' }, { description: '乙' }] });
  plan.present();
  plan.decide('approve');
  assert.strictEqual(plan.get()?.status, 'approved');
  // 只回填 status —— 步骤描述逐字未变。
  plan.write({
    steps: [
      { description: '甲', status: 'done' },
      { description: '乙', status: 'pending' },
    ],
  });
  assert.strictEqual(plan.get()?.status, 'approved', '回填进度不得把计划打回 drafting');
  assert.strictEqual(plan.get()?.steps[0]?.status, 'done', '进度本身要写进去');
});

test('F14：改步骤集合（增删/改写描述）仍回落 drafting 并要求重新审批', () => {
  const plan = new MemoryPlan();
  plan.write({ steps: [{ description: '甲' }] });
  plan.present();
  plan.decide('approve');
  plan.write({ steps: [{ description: '甲' }, { description: '新增一步' }] });
  assert.strictEqual(plan.get()?.status, 'drafting', '步骤集合变化必须重新审批（fail-closed）');

  plan.present();
  plan.decide('approve');
  plan.write({ steps: [{ description: '甲改写了' }] });
  assert.strictEqual(plan.get()?.status, 'drafting', '改写描述同样属集合变化');
});

test('F14：审批前（drafting/presented）回填进度仍按原语义回落 drafting', () => {
  const plan = new MemoryPlan();
  plan.write({ steps: [{ description: '甲' }] });
  plan.present();
  plan.write({ steps: [{ description: '甲', status: 'done' }] });
  assert.strictEqual(plan.get()?.status, 'drafting', '未批准的计划没有「保持批准」可言');
});

test('F14：工具层端到端——回填进度后写类工具仍放行，且回报不再谎称 drafting', async () => {
  const plan = new MemoryPlan();
  const tool = new PlanWriteTool(plan, undefined, undefined as never);
  const call = (steps: unknown[]): ToolCall => ({
    id: 'c1',
    name: 'plan_write',
    arguments: { steps },
  });
  await tool.handle(call([{ description: '甲' }, { description: '乙' }]), ctx);
  plan.present();
  plan.decide('approve');
  const gate = new ToolGate(
    { name: 'allow', decide: async () => 'allow' } as ApprovalPort,
    { name: 'none', check: async () => ({ allowed: true }) } as unknown as SandboxPort,
    plan,
    true,
  );
  const writeCall: ToolCall = { id: 'w1', name: 'write_file', arguments: { path: 'a.ts' } };
  assert.strictEqual(await gate.gate(writeCall, 's1'), undefined, '前置条件：批准后写类工具放行');

  const result = await tool.handle(
    call([
      { description: '甲', status: 'done' },
      { description: '乙', status: 'pending' },
    ]),
    ctx,
  );
  assert.match(result.output ?? '', /状态 approved/, '回报必须反映真实状态');
  assert.strictEqual(
    await gate.gate(writeCall, 's1'),
    undefined,
    '回填进度后写类工具必须仍然放行（旧实现此处被重新锁死）',
  );
});
