import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventPort } from '../../src/ports/eventPort.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';
import type { ToolPort } from '../../src/ports/tool.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import {
  computeLevels,
  WorkflowRunner,
  WorkflowCycleError,
} from '../../src/autonomy/workflowRunner.js';
import type { WorkflowStep } from '../../src/autonomy/workflowTypes.js';
import type { SubagentPorts } from '../../src/subagent/subagentPorts.js';

/** 回显模型：返回最后一条 user 消息内容（便于验证依赖注入——下游步骤 prompt 含上游产出）。 */
class EchoModel implements ModelPort {
  public readonly name = 'echo';

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    return { text: lastUser !== undefined ? lastUser.content : 'done' };
  }
}

/** 含延迟的模型：观测并发峰值。 */
class DelayModel implements ModelPort {
  public readonly name = 'delay';

  public active = 0;
  public peak = 0;

  public constructor(private readonly failMarker?: string) {}

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content ?? '';
    if (this.failMarker !== undefined && text.includes(this.failMarker)) {
      throw new Error('步骤执行失败（测试注入）');
    }
    this.active -= 1;
    return { text: 'ok' };
  }
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

/** 收集型事件端口。 */
class RecordingEvents implements EventPort {
  public readonly name = 'recording';
  public readonly received: unknown[] = [];
  public emit(event: never): void {
    this.received.push(event);
  }
}

describe('computeLevels', () => {
  it('线性链分层正确', () => {
    const steps: WorkflowStep[] = [
      { id: 'A', prompt: 'a' },
      { id: 'B', prompt: 'b', dependsOn: ['A'] },
      { id: 'C', prompt: 'c', dependsOn: ['B'] },
    ];
    assert.deepStrictEqual(computeLevels(steps), [['A'], ['B'], ['C']]);
  });

  it('菱形依赖：B/C 同层、D 在下层', () => {
    const steps: WorkflowStep[] = [
      { id: 'A', prompt: 'a' },
      { id: 'B', prompt: 'b', dependsOn: ['A'] },
      { id: 'C', prompt: 'c', dependsOn: ['A'] },
      { id: 'D', prompt: 'd', dependsOn: ['B', 'C'] },
    ];
    assert.deepStrictEqual(computeLevels(steps), [['A'], ['B', 'C'], ['D']]);
  });

  it('存在环抛 WorkflowCycleError（fail-closed）', () => {
    const steps: WorkflowStep[] = [
      { id: 'A', prompt: 'a', dependsOn: ['B'] },
      { id: 'B', prompt: 'b', dependsOn: ['A'] },
    ];
    assert.throws(() => computeLevels(steps), WorkflowCycleError);
  });

  it('依赖不存在的步骤抛 WorkflowCycleError', () => {
    const steps: WorkflowStep[] = [{ id: 'X', prompt: 'x', dependsOn: ['Y'] }];
    assert.throws(() => computeLevels(steps), WorkflowCycleError);
  });
});

describe('WorkflowRunner', () => {
  it('下游步骤 prompt 注入上游产出（依赖传递）', async () => {
    const runner = new WorkflowRunner(
      makePorts(new EchoModel(), new RecordingEvents(), new RegistryToolPort()),
    );
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '产出甲' },
        { id: 'B', prompt: '基于上游继续', dependsOn: ['A'] },
      ],
    });
    assert.strictEqual(result.ok, true);
    const bOut = result.blackboard['B'];
    assert.ok(bOut !== undefined && bOut.includes('产出甲'), `B 应看到 A 的产出，实际: ${bOut}`);
  });

  it('并发闸门不被突破（两个独立步骤）', async () => {
    const model = new DelayModel();
    const runner = new WorkflowRunner(
      makePorts(model, new RecordingEvents(), new RegistryToolPort()),
      {
        maxConcurrency: 2,
      },
    );
    await runner.run({
      steps: [
        { id: 'A', prompt: 'a' },
        { id: 'B', prompt: 'b' },
      ],
      maxConcurrency: 2,
    });
    assert.ok(model.peak <= 2, `并发峰值应 <=2，实际 ${model.peak}`);
  });

  it('单并发：峰值不超过 1', async () => {
    const model = new DelayModel();
    const runner = new WorkflowRunner(
      makePorts(model, new RecordingEvents(), new RegistryToolPort()),
      {
        maxConcurrency: 1,
      },
    );
    await runner.run({
      steps: [
        { id: 'A', prompt: 'a' },
        { id: 'B', prompt: 'b' },
      ],
      maxConcurrency: 1,
    });
    assert.strictEqual(model.peak, 1);
  });

  it('上游失败 → 下游 fail-closed 跳过（不静默续跑）', async () => {
    const runner = new WorkflowRunner(
      makePorts(new DelayModel('FAIL'), new RecordingEvents(), new RegistryToolPort()),
    );
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '正常步' },
        { id: 'B', prompt: 'FAIL 会失败', dependsOn: ['A'] },
        { id: 'C', prompt: '依赖 B', dependsOn: ['B'] },
      ],
    });
    assert.strictEqual(result.ok, false);
    const b = result.steps.find((step) => step.id === 'B');
    const c = result.steps.find((step) => step.id === 'C');
    assert.strictEqual(b?.ok, false, 'B 应失败');
    assert.strictEqual(c?.ok, false, 'C 应被跳过');
    assert.match(c?.error ?? '', /上游依赖失败/);
  });

  it('无依赖多步全部成功', async () => {
    const runner = new WorkflowRunner(
      makePorts(new EchoModel(), new RecordingEvents(), new RegistryToolPort()),
    );
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: 'a' },
        { id: 'B', prompt: 'b' },
      ],
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.steps.length, 2);
  });
});
