/**
 * 任务拆解链路的**可诊断性**回归（2026-09-26 审计 F2/F12/F15/F18）。
 *
 * 四条缺陷都不是「功能缺失」，而是「模型拿不到能据以自修的信息 / 能力被自己藏起来」：
 *  F2  worker 失败原因只进 output，而投影层对 ok=false 只渲染 error ⇒ 模型看到「未知错误」；
 *  F12 环 / 重复 id / 悬空依赖三类拆解错误坍缩成同一句「存在环」且不含步骤 id ⇒ 只能盲改 spec；
 *  F15 `run_workflow` / `run_goal` 未进写类集合 ⇒ plan 模式与监督内核都不把它们当危险操作；
 *  F18 `OMNI_TOOL_EXPOSURE=plan` 把规划工具本身降级 ⇒ 模型想拆解却找不到写待办的入口。
 *
 * 本文件对四条逐一给可证伪断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowRunner, WorkflowCycleError } from '../../src/autonomy/workflowRunner.js';
import type { WorkflowStep } from '../../src/autonomy/workflowTypes.js';
import { DelegateTool } from '../../src/adapters/tool/workflow/delegateTool.js';
import type { WorkerOrchestrator } from '../../src/worker/workerOrchestrator.js';
import { ToolExposurePlanner } from '../../src/core/toolExposurePlanner.js';
import { MUTATING_TOOL_NAMES, TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

/** 构造工作流步骤（只用到 id / dependsOn 的最小形状）。 */
function step(id: string, dependsOn: readonly string[] = []): WorkflowStep {
  return { id, prompt: id, ...(dependsOn.length > 0 ? { dependsOn } : {}) } as WorkflowStep;
}

test('F12：重复 step id 的报错点名到 id（不再只说「存在环」）', () => {
  const error = (() => {
    try {
      WorkflowRunner.computeLevels([step('a'), step('a')]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof WorkflowCycleError, '应抛 WorkflowCycleError');
  assert.match(error.message, /id 重复/, '应说明是 id 重复');
  assert.match(error.message, /a/, '应点名到涉事 id');
});

test('F12：悬空依赖的报错同时给出「谁依赖谁」与可用步骤', () => {
  const error = (() => {
    try {
      WorkflowRunner.computeLevels([step('b', ['a'])]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof WorkflowCycleError);
  assert.match(error.message, /不存在的步骤/);
  assert.match(error.message, /「b」/, '应点名依赖方');
  assert.match(error.message, /「a」/, '应点名缺失的依赖');
});

test('F12：真环的报错列出无法排序的步骤 id', () => {
  const error = (() => {
    try {
      WorkflowRunner.computeLevels([step('a', ['b']), step('b', ['a'])]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof WorkflowCycleError);
  assert.match(error.message, /依赖成环/);
  assert.match(error.message, /a/);
  assert.match(error.message, /b/);
  // 合法 DAG 仍照常分层（不得因增强报错而改变正常路径）。
  assert.deepStrictEqual(WorkflowRunner.computeLevels([step('a'), step('b', ['a'])]), [
    ['a'],
    ['b'],
  ]);
});

test('F2：worker 失败时原因必须进 error（否则模型只看到「未知错误」）', async () => {
  const failing = {
    delegate: async () => ({ ok: false, output: 'worker cli-a 退出码 1：tsc 报 TS2345' }),
  } as unknown as WorkerOrchestrator;
  const tool = new DelegateTool(failing);
  const call: ToolCall = {
    id: 'c1',
    name: TOOL_NAMES.delegate,
    arguments: { worker: 'cli-a', task: 'x' },
  };
  const result = await tool.handle(call, {
    sessionId: 's',
    workspaceRoot: process.cwd(),
  } as ToolContext);
  assert.strictEqual(result.ok, false);
  assert.match(
    result.error ?? '',
    /退出码 1/,
    '失败原因必须落在 error 字段（ContextAssembler 对 ok=false 只渲染 error）',
  );
});

test('F2：worker 成功时正常回 output（不得因修失败路径而改变成功语义）', async () => {
  const okWorker = {
    delegate: async () => ({ ok: true, output: '完成' }),
  } as unknown as WorkerOrchestrator;
  const tool = new DelegateTool(okWorker);
  const result = await tool.handle(
    { id: 'c1', name: TOOL_NAMES.delegate, arguments: { worker: 'cli-a', task: 'x' } },
    { sessionId: 's', workspaceRoot: process.cwd() } as ToolContext,
  );
  assert.strictEqual(result.ok, true);
  assert.match(result.output ?? '', /\[cli-a\] 完成/);
});

test('F15：run_workflow / run_goal 属写类（plan 门禁与监督内核必须当危险操作拦）', () => {
  assert.ok(MUTATING_TOOL_NAMES.has(TOOL_NAMES.runWorkflow), 'run_workflow 漏收');
  assert.ok(MUTATING_TOOL_NAMES.has(TOOL_NAMES.runGoal), 'run_goal 漏收');
  // 与它们同级的子代理入口早已在内——口径必须一致。
  assert.ok(MUTATING_TOOL_NAMES.has(TOOL_NAMES.subagent));
  assert.ok(MUTATING_TOOL_NAMES.has(TOOL_NAMES.delegate));
});

test('F18：规划工具恒可见（任务文本不含「计划/待办」字样时也不得被降级）', () => {
  const tools = [
    TOOL_NAMES.todoWrite,
    TOOL_NAMES.todoRead,
    TOOL_NAMES.planWrite,
    TOOL_NAMES.planRead,
    TOOL_NAMES.planPresent,
    TOOL_NAMES.readFile,
    TOOL_NAMES.browserScreenshot,
  ];
  const plan = ToolExposurePlanner.plan({ taskText: '重构这个模块', tools });
  for (const name of [
    TOOL_NAMES.todoWrite,
    TOOL_NAMES.todoRead,
    TOOL_NAMES.planWrite,
    TOOL_NAMES.planRead,
    TOOL_NAMES.planPresent,
  ]) {
    assert.ok(plan.visible.includes(name), `${name} 必须恒可见（规划是元能力）`);
  }
});
