import type { ApprovalPort } from '../runtime/approval.js';
import type { EventPort } from '../runtime/eventPort.js';
import type { ModelPort } from '../model/model.js';
import type { SandboxPort } from '../runtime/sandbox.js';
import type { StoragePort } from '../memory/storage.js';
import type { SpillPort } from '../memory/spill.js';
import type { ToolPort } from '../tool/tool.js';
import type { EscalationPort } from '../runtime/escalation.js';
import type { NativeToolRunner } from '../../native/nativeBackend.js';
import type { ToolResultSpiller } from '../../context/toolResultSpiller.js';
import type { LongTermMemoryPort } from '../memory/longTermMemory.js';

/**
 * @beta
 * 子智能体所需的最小端口集合。
 * 存在的意义：`ConfigFactory.defaultTools` 需要在运行时装配完成之前就注册 subagent 工具，
 * 而编排器又依赖工具端口——直接依赖 `OmniHarnessRuntime` 会形成循环依赖，故投影为最小集。
 */
export interface SubagentPortsShape {
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
