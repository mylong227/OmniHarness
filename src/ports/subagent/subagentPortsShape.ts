import type { ApprovalPort } from '../runtime/approval.js';
import type { EventPort } from '../runtime/eventPort.js';
import type { ModelPort } from '../model/model.js';
import type { SandboxPort } from '../runtime/sandbox.js';
import type { StoragePort } from '../memory/storage.js';
import type { SpillPort } from '../memory/spill.js';
import type { ToolPort } from '../tool/tool.js';
import type { EscalationPort } from '../runtime/escalation.js';
import type { NativeToolRunner } from '../../native/nativeBackend.js';
import type { ToolResultSpillerPort } from '../context/toolResultSpillerPort.js';
import type { LongTermMemoryPort } from '../memory/longTermMemory.js';
import type { PlanPort } from '../runtime/plan.js';
import type { SupervisorPort } from '../runtime/supervisor.js';

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
  readonly spiller: ToolResultSpillerPort;
  readonly workspaceRoot: string;
  readonly maxSteps: number;
  /** 长期记忆端口（#S28）：与父共享，使子代继承跨会话持久记忆读写。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** 自主目标循环默认最大迭代次数（#S30，供 run_goal 工具读取）。 */
  readonly goalMaxIterations: number;
  readonly native?: NativeToolRunner | undefined;
  /**
   * 计划端口（可选）：子代门禁须与父级共用同一计划状态源。
   *
   * 存在理由（2026-10-01 审计）：子代原先硬编码 `plan: undefined` + `planMode: false`，
   * 于是「`--plan` 只读规划模式」在委派路径上被完全绕过 —— 模型只要调一次 `subagent` /
   * `run_workflow` / `run_goal` 就能落盘，而子代事件走独立 bridge，主会话侧完全静默。
   * 更隐蔽的是 `ToolGate` 的 plan 拦截要求 `plan !== undefined`，故「只继承 planMode 不继承
   * plan」同样拦不住，两者必须成对透传。
   */
  readonly plan?: PlanPort | undefined;
  /**
   * 是否处于计划模式（可选，缺省 false）：父级开启时子代必须继承，否则只读语义失效。
   */
  readonly planMode?: boolean | undefined;
  /**
   * 航天级监督内核（可选）：父级把它置于审批/沙箱/计划之前做确定性否决；子代原先整体缺省，
   * 导致 safe/locked 模式下子代工具失败既不进健康监控、也不受确定性否决约束。
   */
  readonly supervisor?: SupervisorPort | undefined;
  /**
   * 子代系统提示片段（可选，缺省无）。
   *
   * 存在理由（2026-10-06 第六十一轮真实模型跑测实测）：`SubagentRuntimeFactory` 原先把子代
   * `fragments` 留空，于是子代**没有任何系统提示**——事件里的 `context.tokens.systemPrompt`
   * 实测为 **0**（同一台机上主会话是 740）。后果不是"少点风格"，而是**少掉运行环境**：子代在
   * Windows 上照着训练语料的 POSIX 假设连发 `pwd` / `ls -la`，被 `cmd.exe` 回「不是内部或外部命令」，
   * 于是**把"命令不存在"误判成"隔离环境 shell 不可用"**，并把这条错误结论回传给主代理
   * （主代理照抄进了最终答复）。故由组合根注入**运行环境那一段**（不是主会话的整段编码 SOP——
   * 子代工具集是裁剪过的，整段 SOP 会指向它没有的工具）。
   */
  readonly fragments?: readonly string[] | undefined;
}
