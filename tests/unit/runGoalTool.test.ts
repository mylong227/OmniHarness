import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { RunGoalTool } from '../../src/adapters/tool/workflow/runGoalTool.js';
import { RUN_GOAL_TOOL_NAME } from '../../src/autonomy/goalToolNames.js';
import type { SubagentPorts } from '../../src/subagent/subagentPorts.js';
import type { AgentFactoryPort, AgentPort } from '../../src/ports/runtime/agent.js';
import type { OmniHarnessRuntime } from '../../src/composition/runtime.js';
import { Agent } from '../../src/core/agent.js';

/**
 * 脚本化模型：区分「目标循环推进」与「达成度判定」两类调用。
 * - 推进调用（无 checker 系统提示）→ 返回进度文本，主循环 1 步即结束；
 * - 判定调用（含 checker 系统提示）→ 返回注入的 YES/NO。
 */
class GoalScriptModel implements ModelPort {
  public readonly name = 'goal-script';

  public readonly frames: string[][] = [];

  public constructor(private readonly verdict: 'YES 已完成' | 'NO 未完成') {}

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.frames.push(request.tools.map((tool) => tool.name));
    const isChecker = request.messages.some(
      (message) => message.role === 'system' && message.content.includes('目标达成度评审'),
    );
    if (isChecker) {
      return { text: this.verdict };
    }
    return { text: '本轮推进了目标' };
  }
}

/** 收集型事件端口。 */
class RecordingEvents implements EventPort {
  public readonly name = 'recording';

  public readonly received: SessionEvent[] = [];

  public emit(event: SessionEvent): void {
    this.received.push(event);
  }
}

/** 构造含 echo/shell/run_goal/subagent 四工具的注册表（验证工具视图裁剪）。 */
function makeTools(): RegistryToolPort {
  const registry = new RegistryToolPort();
  const blank = { type: 'object', properties: {}, required: [] } as const;
  for (const name of ['echo', 'shell', RUN_GOAL_TOOL_NAME, 'subagent']) {
    registry.register({ name, description: name, parameters: blank }, async (call) => ({
      callId: call.id,
      ok: true,
      output: `${name} ok`,
    }));
  }
  return registry;
}

/** 内存版长期记忆桩。 */
function makeLongTermStub(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: (query, k) =>
      facts
        .map((fact, index) => ({ fact, score: fact.text.includes(query) ? 1 : 0, index }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((entry) => entry.fact),
    all: () => facts,
    get: (id) => facts.find((f) => f.id === id),
    update: (id, patch) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts[i] = { ...facts[i]!, ...patch };
      return true;
    },
    delete: (id) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts.splice(i, 1);
      return true;
    },
    get count() {
      return facts.length;
    },
  };
}

/** 构造子智能体端口集。 */
function makePorts(model: ModelPort, events: EventPort, tools: ToolPort): SubagentPorts {
  const spill = new MemorySpill();
  return {
    model,
    tools,
    storage: new MemoryStorage(),
    events,
    sandbox: new PassthroughSandbox(),
    approvals: new AutoApproval(),
    escalation: new DenyEscalation(),
    elevatedSandbox: new PassthroughSandbox(),
    spill,
    spiller: new ToolResultSpiller(spill, { maxInlineBytes: 1024, previewBytes: 256 }),
    workspaceRoot: process.cwd(),
    maxSteps: 8,
    longTermMemory: makeLongTermStub(),
    goalMaxIterations: 10,
  };
}

/** 测试用 Agent 工厂：直接构造真实 Agent，驱动目标循环。 */
class TestAgentFactory implements AgentFactoryPort {
  /**
   * 按子智能体运行时构造真实 Agent。
   * @param runtime 子智能体运行时。
   * @returns Agent 端口实现。
   */
  public create(runtime: OmniHarnessRuntime): AgentPort {
    return new Agent(runtime);
  }
}

describe('RunGoalTool', () => {
  const factory = new TestAgentFactory();
  it('缺少 goal 直接拒绝', async () => {
    const tool = new RunGoalTool(
      makePorts(new GoalScriptModel('NO 未完成'), new RecordingEvents(), makeTools()),
      {},
      factory,
    );
    const result = await tool.handle(
      { id: 'c1', name: RUN_GOAL_TOOL_NAME, arguments: {} },
      { sessionId: 's', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /缺少子目标描述/);
  });

  it('达成：首轮即判达成，子代工具集剔除 run_goal/subagent', async () => {
    const model = new GoalScriptModel('YES 已完成');
    const tool = new RunGoalTool(makePorts(model, new RecordingEvents(), makeTools()), {}, factory);
    const result = await tool.handle(
      { id: 'c2', name: RUN_GOAL_TOOL_NAME, arguments: { goal: '达成X' } },
      { sessionId: 's', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /已达成/);
    const visible = model.frames[0] ?? [];
    assert.ok(
      !visible.includes(RUN_GOAL_TOOL_NAME),
      `子代不应看到 ${RUN_GOAL_TOOL_NAME}: ${visible.join(',')}`,
    );
    assert.ok(!visible.includes('subagent'), `子代不应看到 subagent: ${visible.join(',')}`);
  });

  it('未达成：跑到上限后停止，不无限循环', async () => {
    const model = new GoalScriptModel('NO 未完成');
    const tool = new RunGoalTool(
      makePorts(model, new RecordingEvents(), makeTools()),
      { maxIterations: 2 },
      factory,
    );
    const result = await tool.handle(
      { id: 'c3', name: RUN_GOAL_TOOL_NAME, arguments: { goal: '达成Y' } },
      { sessionId: 's', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(result.ok, true, `工具应成功返回（实际: ${result.error ?? ''}）`);
    assert.match(result.output ?? '', /未达成/);
    assert.strictEqual(model.frames.length, 4, '2 轮 ×（推进 + 判定）= 4 次模型调用');
  });
});
