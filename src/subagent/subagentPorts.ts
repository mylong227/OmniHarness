import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { ModelPort } from '../ports/model/model.js';
import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { StoragePort } from '../ports/memory/storage.js';
import type { SpillPort } from '../ports/memory/spill.js';
import type { ToolPort } from '../ports/tool/tool.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';
import type { NativeToolRunner } from '../native/nativeBackend.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import type { OmniHarnessRuntime } from '../composition/runtime.js';

/**
 * @beta
 * 子智能体所需的最小端口集合。
 * 存在的意义：`ConfigFactory.defaultTools` 需要在运行时装配完成之前就注册 subagent 工具，
 * 而编排器又依赖工具端口——直接依赖 `OmniHarnessRuntime` 会形成循环依赖，故投影为最小集。
 */
export interface SubagentPorts {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly storage: StoragePort;
  readonly events: EventPort;
  readonly sandbox: SandboxPort;
  readonly approvals: ApprovalPort;
  /** 升级审批端口（#G3/G4）：沙箱拒绝时咨询，决定是否提权重试。 */
  readonly escalation: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，默认无沙箱）：escalate 裁决后以此复核放行。 */
  readonly elevatedSandbox: SandboxPort;
  readonly spill: SpillPort;
  readonly spiller: ToolResultSpiller;
  readonly workspaceRoot: string;
  readonly maxSteps: number;
  /** 长期记忆端口（#S28）：与父共享，使子代继承跨会话持久记忆读写。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** 自主目标循环默认最大迭代次数（#S30，供 run_goal 工具读取）。 */
  readonly goalMaxIterations: number;
  readonly native?: NativeToolRunner | undefined;
}

/**
 * @beta
 * 从运行时投影出子智能体端口集（供库使用方在装配完成后自行编排）。
 */
export function portsOf(runtime: OmniHarnessRuntime): SubagentPorts {
  return {
    model: runtime.model,
    tools: runtime.tools,
    storage: runtime.storage,
    events: runtime.events,
    sandbox: runtime.sandbox,
    approvals: runtime.approvals,
    escalation: runtime.escalation,
    elevatedSandbox: runtime.elevatedSandbox,
    spill: runtime.config.spill,
    spiller: runtime.spiller,
    workspaceRoot: runtime.config.workspaceRoot,
    maxSteps: runtime.config.maxSteps,
    longTermMemory: runtime.longTermMemory,
    goalMaxIterations: runtime.config.goalMaxIterations,
    native: runtime.native,
  };
}
