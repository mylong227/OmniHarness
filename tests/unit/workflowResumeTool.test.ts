/**
 * 模型工具 `run_workflow` 的 **resume 参数**判据（2026-10-08）。
 *
 * ## 为什么单独钉工具这一层
 *
 * `workflowControlledRun.test.ts` 钉的是 runner 的续跑语义、`graphResumeRpc.test.ts` 钉的是 serve 的
 * RPC 缝，而**模型面入口**（`run_workflow({resume})`）此前零判据：参数合法性、`spec` 与 `resume`
 * 二选一的校验、续跑提示文本、以及「续跑时用哪一份定义」都只靠代码审查。
 * 本仓的缺陷家族里「声明了但没接线」占大头——模型面入口恰恰是模型唯一能碰到的那一层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { RunWorkflowTool } from '../../src/adapters/tool/workflow/runWorkflowTool.js';
import { WorkflowRunLog } from '../../src/autonomy/workflowRunLog.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';
import type { WorkflowDef } from '../../src/autonomy/workflowTypes.js';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.js';

/** 回显模型：把最后一条 user 消息原样作为产出（便于断言「续跑复用」而非重跑）。 */
class EchoModel implements ModelPort {
  /** 端口名（适配器契约要求）。 */
  public readonly name = 'echo';

  /** 被调用的次数（用于断言「复用则不重跑」）。 */
  public calls = 0;

  /**
   * @param request 模型请求。
   * @returns 最后一条 user 消息内容。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.calls += 1;
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    return { text: lastUser?.content ?? 'done' };
  }
}

/** 收集型事件端口（本判据不消费事件，只需满足契约）。 */
class RecordingEvents implements EventPort {
  /** 端口名（适配器契约要求）。 */
  public readonly name = 'recording';

  /**
   * @param event 被忽略的事件。
   * @returns 无返回值。
   */
  public emit(event: never): void {
    void event;
  }
}

/** 内存版长期记忆桩。 */
function makeLongTermStub(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: () => [],
    all: () => facts,
    get: (id) => facts.find((f) => f.id === id),
    update: () => false,
    delete: () => false,
    get count() {
      return facts.length;
    },
  };
}

/**
 * 构造子智能体端口集（工作区指向临时目录，避免把运行存档写进仓库）。
 * @param model 模型端口。
 * @param workspaceRoot 工作区根。
 * @returns 端口束。
 */
function makePorts(model: ModelPort, workspaceRoot: string): SubagentPortsShape {
  const spill = new MemorySpill();
  return {
    model,
    tools: new RegistryToolPort(),
    storage: new MemoryStorage(),
    events: new RecordingEvents(),
    sandbox: new PassthroughSandbox(),
    approvals: new AutoApproval(),
    escalation: new DenyEscalation(),
    elevatedSandbox: new PassthroughSandbox(),
    spill,
    spiller: new ToolResultSpiller(spill, { maxInlineBytes: 1024, previewBytes: 256 }),
    workspaceRoot,
    maxSteps: 8,
    longTermMemory: makeLongTermStub(),
    goalMaxIterations: 10,
  };
}

/** 单步定义（步骤 id 固定，便于断言存档）。 */
const DEF: WorkflowDef = { name: 'tool-resume', steps: [{ id: 's1', prompt: '产出甲' }] };

/**
 * 从工具输出里取出 runId。
 * @param text 工具输出（形如「工作流全部完成（runId: wf-…）」）。
 * @returns runId；未命中返回 undefined。
 */
function runIdOf(text: string | undefined): string | undefined {
  return /runId:\s*([A-Za-z0-9_-]+)/.exec(text ?? '')?.[1];
}

test('run_workflow：resume 复用已完成步骤的产出，且不重跑', async () => {
  const root = tempWorkspace();
  const model = new EchoModel();
  const tool = new RunWorkflowTool(makePorts(model, root));
  const context = { sessionId: 'sess-1', workspaceRoot: root };

  const first = await tool.handle(
    { id: 'c1', name: 'run_workflow', arguments: { spec: DEF } },
    context,
  );
  assert.strictEqual(first.ok, true, first.error ?? '');
  const runId = runIdOf(first.output);
  assert.ok(runId !== undefined, `输出必须带 runId：${first.output ?? ''}`);
  const callsAfterFirst = model.calls;

  const second = await tool.handle(
    { id: 'c2', name: 'run_workflow', arguments: { resume: runId } },
    context,
  );
  assert.strictEqual(second.ok, true, second.error ?? '');
  assert.match(second.output ?? '', /续跑复用 1 步：s1/, `应报告复用：${second.output ?? ''}`);
  assert.strictEqual(model.calls, callsAfterFirst, '已完成的步骤必须复用产出（不得再跑一次模型）');

  const log = new WorkflowRunLog(root);
  const lines = readFileSync(log.pathOf(runId!), 'utf8').trim().split('\n');
  assert.strictEqual(
    lines.filter((line) => line.includes('"t":"run.start"')).length,
    1,
    '续跑不得新写 run.start',
  );
});

test('run_workflow：resume + 不一致的 spec ⇒ fail-closed（不把两份定义拼在一起）', async () => {
  const root = tempWorkspace();
  const tool = new RunWorkflowTool(makePorts(new EchoModel(), root));
  const context = { sessionId: 'sess-1', workspaceRoot: root };
  const first = await tool.handle(
    { id: 'c1', name: 'run_workflow', arguments: { spec: DEF } },
    context,
  );
  const runId = runIdOf(first.output)!;

  const other: WorkflowDef = { steps: [{ id: 's1', prompt: '完全不同的定义' }] };
  const bad = await tool.handle(
    { id: 'c2', name: 'run_workflow', arguments: { resume: runId, spec: other } },
    context,
  );
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error ?? '', /规格与本次传入的 spec 不一致/);
});

test('run_workflow：参数校验（既无 spec 也无 resume / resume 类型错 / runId 不存在）', async () => {
  const root = tempWorkspace();
  const tool = new RunWorkflowTool(makePorts(new EchoModel(), root));
  const context = { sessionId: 'sess-1', workspaceRoot: root };

  const neither = await tool.handle({ id: 'c1', name: 'run_workflow', arguments: {} }, context);
  assert.strictEqual(neither.ok, false);
  assert.match(neither.error ?? '', /缺少工作流定义/);

  const wrongType = await tool.handle(
    { id: 'c2', name: 'run_workflow', arguments: { resume: 42 } },
    context,
  );
  assert.strictEqual(wrongType.ok, false);
  assert.match(wrongType.error ?? '', /resume 必须是字符串/);

  const unknown = await tool.handle(
    { id: 'c3', name: 'run_workflow', arguments: { resume: 'wf-does-not-exist' } },
    context,
  );
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error ?? '', /找不到运行日志/);
});

test('run_workflow：中断点（有 start 无 end）在 resume 时被重跑并留下 attempt 留痕', async () => {
  const root = tempWorkspace();
  const model = new EchoModel();
  const tool = new RunWorkflowTool(makePorts(model, root));
  const context = { sessionId: 'sess-1', workspaceRoot: root };
  const first = await tool.handle(
    { id: 'c1', name: 'run_workflow', arguments: { spec: DEF } },
    context,
  );
  const runId = runIdOf(first.output)!;

  // 模拟「s1 跑到一半进程被杀」：手工追加一条 start（无 end）。
  const log = new WorkflowRunLog(root);
  log.appendStepStart(runId, 's1', 2);
  const before = model.calls;

  const resumed = await tool.handle(
    { id: 'c2', name: 'run_workflow', arguments: { resume: runId } },
    context,
  );
  assert.strictEqual(resumed.ok, true, resumed.error ?? '');
  assert.strictEqual(model.calls, before + 1, '中断的步骤必须真的重跑一次');

  const path = log.pathOf(runId);
  assert.ok(existsSync(path));
  const text = readFileSync(path, 'utf8');
  assert.match(
    text,
    /"t":"step.end","id":"s1","status":"done","attempt":3/,
    '重跑应记为第 3 次尝试',
  );
});
