/**
 * 就绪队列调度判据：全只读 DAG 去掉层屏障后，下游步骤可在慢兄弟完成前启动。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EventPort } from '../../src/contracts/ports/runtime/eventPort.ts';
import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
} from '../../src/contracts/ports/model/model.ts';
import type { ToolPort } from '../../src/contracts/ports/tool/tool.ts';
import { AutoApproval } from '../../src/kernel/adapters/approval/autoApproval.ts';
import { MemoryStorage } from '../../src/kernel/adapters/storage/memoryStorage.ts';
import { PassthroughSandbox } from '../../src/kernel/adapters/sandbox/passthroughSandbox.ts';
import { DenyEscalation } from '../../src/kernel/adapters/escalation/denyEscalation.ts';
import { MemorySpill } from '../../src/kernel/adapters/spill/memorySpill.ts';
import { RegistryToolPort } from '../../src/kernel/adapters/tool/registryToolPort.ts';
import { ToolResultSpiller } from '../../src/kernel/context/toolResultSpiller.ts';
import { WorkflowRunner } from '../../src/kernel/autonomy/workflowRunner.ts';
import { WorkflowReadyScheduler } from '../../src/kernel/autonomy/workflowReadyScheduler.ts';
import type { WorkflowStep } from '../../src/kernel/autonomy/workflowTypes.ts';
import type { SubagentPortsShape } from '../../src/kernel/subagent/subagentPorts.ts';

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
    // A 的慢延迟 1200ms（2026-11-01 由 120 上调到 400；2026-11-03 再上调到 1200）：
    // 全量并行跑时 worker 被抢占会让「B 完成 → C 启动」的 promise 链被推迟数百毫秒，
    // 实测两次全量分别出现「C.start 晚于 A.end 268ms」「恰好相等」——400ms 余量仍被压塌。
    // 断言语义不变（C 必须先于 A 完成启动），只是把余量放大到抢占尺度之上。
    await new Promise((resolve) => setTimeout(resolve, id === 'A' ? 1200 : 10));
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
