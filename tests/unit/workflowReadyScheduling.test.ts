/**
 * 就绪队列调度判据：全只读 DAG 去掉层屏障后，下游步骤可在慢兄弟完成前启动。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EventPort } from '../../src/ports/runtime/eventPort.ts';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.ts';
import type { ToolPort } from '../../src/ports/tool/tool.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.ts';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.ts';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.ts';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.ts';
import { WorkflowRunner } from '../../src/autonomy/workflowRunner.ts';
import { WorkflowReadyScheduler } from '../../src/autonomy/workflowReadyScheduler.ts';
import type { WorkflowStep } from '../../src/autonomy/workflowTypes.ts';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.ts';

interface TimedEvent {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

/** 按步骤 id 延迟的模型（id = 最后一条 user 消息首字符）。 */
class TimedModel implements ModelPort {
  public readonly name = 'timed';
  public readonly events: TimedEvent[] = [];

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const id = (lastUser?.content ?? '?').slice(0, 1);
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, id === 'A' ? 120 : 10));
    this.events.push({ id, start, end: Date.now() });
    return { text: 'ok' };
  }
}

/** 最小端口集。 */
function ports(model: ModelPort, events: EventPort, tools: ToolPort): SubagentPortsShape {
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
    maxSteps: 4,
    longTermMemory: {
      name: 'stub',
      remember: () => undefined,
      recall: () => [],
      all: () => [],
      get: () => undefined,
      update: () => false,
      delete: () => false,
      get count() {
        return 0;
      },
    } as unknown as SubagentPortsShape['longTermMemory'],
    goalMaxIterations: 4,
  };
}

/** 静默事件端口。 */
class SilentEvents implements EventPort {
  public readonly name = 'silent';
  public emit(_event: never): void {}
}

/** 全只读步骤（显式 tools 让 mayWrite=false）。 */
const STEPS: WorkflowStep[] = [
  { id: 'A', prompt: 'A slow', tools: ['read_file'] },
  { id: 'B', prompt: 'B fast', tools: ['read_file'] },
  { id: 'C', prompt: 'C child', tools: ['read_file'], dependsOn: ['B'] },
];

/** 取事件时间。 */
function eventOf(events: readonly TimedEvent[], id: string): TimedEvent {
  const found = events.find((event) => event.id === id);
  assert.ok(found !== undefined, `缺少步骤 ${id} 的计时事件`);
  return found;
}

test('就绪调度：C 在慢兄弟 A 完成前启动；levels 档被层屏障挡住', async () => {
  assert.match(WorkflowReadyScheduler.blockedReason(['A']), /上游依赖失败/u);
  const ready = new TimedModel();
  await new WorkflowRunner(ports(ready, new SilentEvents(), new RegistryToolPort()), {
    maxConcurrency: 2,
    scheduling: 'ready',
  }).run({ steps: STEPS, maxConcurrency: 2 });
  const readyA = eventOf(ready.events, 'A');
  const readyC = eventOf(ready.events, 'C');
  assert.ok(readyC.start < readyA.end, `ready: C.start=${readyC.start} 应早于 A.end=${readyA.end}`);

  const levels = new TimedModel();
  await new WorkflowRunner(ports(levels, new SilentEvents(), new RegistryToolPort()), {
    maxConcurrency: 2,
    scheduling: 'levels',
  }).run({ steps: STEPS, maxConcurrency: 2 });
  const levelsA = eventOf(levels.events, 'A');
  const levelsC = eventOf(levels.events, 'C');
  assert.ok(levelsC.start >= levelsA.end - 5, 'levels: C 必须等 A 完成后才启动');
});
