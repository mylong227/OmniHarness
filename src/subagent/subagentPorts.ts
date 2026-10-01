import type { OmniHarnessRuntime } from '../composition/runtime.js';
import type { SubagentPortsShape } from '../ports/subagent/subagentPortsShape.js';

/**
 * SubagentPortsShape —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class SubagentPorts {
  /**
   * @beta
   * 从运行时投影出子智能体端口集（供库使用方在装配完成后自行编排）。
   */
  public static portsOf(runtime: OmniHarnessRuntime): SubagentPortsShape {
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
}

/**
 * 子智能体最小端口集（契约唯一声明见 `src/ports/subagent/subagentPortsShape.ts`；
 * 此处为原路径再导出，调用点零改动）。
 */
export type { SubagentPortsShape };
