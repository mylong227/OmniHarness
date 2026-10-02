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
      // 门禁三件套透传（2026-10-01 审计）：plan + planMode 必须成对继承，supervisor 使子代
      // 受父级确定性否决约束并向监督内核上报健康信号。三者缺省时子代退回「无 plan 门禁、
      // 无监督」的老行为，故此处显式投影，避免委派路径成为安全语义的旁路。
      plan: runtime.config.plan,
      planMode: runtime.config.planMode,
      supervisor: runtime.supervisor,
    };
  }
}

/**
 * 子智能体最小端口集（契约唯一声明见 `src/ports/subagent/subagentPortsShape.ts`；
 * 此处为原路径再导出，调用点零改动）。
 */
export type { SubagentPortsShape };
