/**
 * 探针：`run_workflow` 工具的 `ok` 语义与其 `@returns` 契约。
 *
 * 声称（`runWorkflowTool.ts` 的 JSDoc）：
 *   「执行结果：spec 非法/含环/**步骤失败**返回失败；成功附各步骤结果渲染文本。」
 * 实测：`runner.run()` 正常返回（不抛错）时**恒** `ok: true`，即便
 * `result.ok === false`（有步骤失败）且渲染文本首行写着「工作流存在失败步骤」。
 * 对照同族的 `subagentTool.ts`（失败即 `ok:false`）——同子系统内两条工具对
 * 「子任务失败」的模型面语义相反，所有按 `ok` 分流的消费者（UI/统计/调用方重试/
 * CLI 退出码 `cliAgentCmds.ts`）都会把「整条工作流有步骤失败」当成成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunWorkflowTool } from '../../src/adapters/tool/workflow/runWorkflowTool.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';

/** 收集型事件端口。 */
class RecordingEvents implements EventPort {
  /** 端口名（端口契约要求）。 */
  public readonly name = 'recording';

  /**
   * 丢弃事件（本探针不消费）。
   * @param _event 运行时事件。
   * @returns 无返回值。
   */
  public emit(_event: SessionEvent): void {
    /* 不消费 */
  }
}

/** 回显模型：把最后一条 user 消息原文回吐；命中失败标记则抛错（模拟步骤失败）。 */
class EchoModel implements ModelPort {
  /** 端口名。 */
  public readonly name = 'echo';

  /**
   * @param failMarker 末条 user 消息含该串时抛错（模拟该步骤失败）。
   */
  public constructor(private readonly failMarker?: string) {}

  /**
   * 生成回显文本。
   * @param request 模型请求（取最后一条 user 消息）。
   * @returns 末条 user 文本。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser !== undefined ? lastUser.content : 'done';
    if (this.failMarker !== undefined && text.includes(this.failMarker)) {
      throw new Error(`步骤执行失败（探针注入）: ${this.failMarker}`);
    }
    return { text };
  }
}

/** 内存版长期记忆桩（子会话构造需要）。 */
const makeLongTerm = (): LongTermMemoryPort => {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact: MemoryFact) => {
      facts.push(fact);
    },
    recall: () => [],
    all: () => facts,
    count: facts.length,
  } as unknown as LongTermMemoryPort;
};

/**
 * 构造最小可跑的子智能体端口束。
 * @param model 子会话使用的模型（注入失败标记即可制造步骤失败）。
 * @returns 端口束。
 */
const makePorts = (model: ModelPort): SubagentPortsShape => {
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
    workspaceRoot: process.cwd(),
    maxSteps: 8,
    longTermMemory: makeLongTerm(),
    goalMaxIterations: 10,
  } as unknown as SubagentPortsShape;
};

/** 工具上下文。 */
const ctx = { sessionId: 'sess-1', workspaceRoot: process.cwd() };

test('步骤失败的 run_workflow 必须返回 ok:false（@returns 明写「步骤失败返回失败」）', async () => {
  const tool = new RunWorkflowTool(makePorts(new EchoModel('FAIL')));
  const result = await tool.handle(
    {
      id: 'c1',
      name: 'run_workflow',
      arguments: { spec: { steps: [{ id: 'a', prompt: 'FAIL' }] } },
    },
    ctx,
  );
  assert.strictEqual(result.ok, false, `步骤失败却报成功，output=${String(result.output)}`);
  assert.match(
    String(result.error ?? result.output),
    /步骤执行失败|失败步骤/,
    '失败结果必须把失败原因带给模型',
  );
});

test('对照：全部步骤成功的 run_workflow 仍返回 ok:true + 渲染文本', async () => {
  const tool = new RunWorkflowTool(makePorts(new EchoModel()));
  const result = await tool.handle(
    { id: 'c1', name: 'run_workflow', arguments: { spec: { steps: [{ id: 'a', prompt: 'ok' }] } } },
    ctx,
  );
  assert.strictEqual(result.ok, true);
  assert.match(String(result.output), /工作流全部完成/);
});

test('对照：spec 非法仍返回 ok:false（既有正确行为不回退）', async () => {
  const tool = new RunWorkflowTool(makePorts(new EchoModel()));
  const bad = await tool.handle({ id: 'c1', name: 'run_workflow', arguments: {} }, ctx);
  assert.strictEqual(bad.ok, false);
  const empty = await tool.handle(
    { id: 'c2', name: 'run_workflow', arguments: { spec: { steps: [] } } },
    ctx,
  );
  assert.strictEqual(empty.ok, false);
});
