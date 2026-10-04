import type { ApprovalPort } from '../runtime/approval.js';
import type { EventPort } from '../runtime/eventPort.js';
import type { SandboxPort } from '../runtime/sandbox.js';
import type { SpillPort } from '../memory/spill.js';
import type { RetrievalPort } from '../intelligence/retrieval.js';
import type { EscalationPort } from '../runtime/escalation.js';
import type { TodoPort } from '../runtime/todo.js';
import type { PlanPort } from '../runtime/plan.js';
import type { UserResponder } from '../runtime/userResponder.js';
import type { ToolHookRunnerPort } from '../tool/toolHookRunnerPort.js';
import type { ToolDiscoveryPort } from '../tool/toolDiscoveryPort.js';
import type { ToolResultSpillerPort } from '../context/toolResultSpillerPort.js';
import type { TurnDiffTrackerPort } from '../runtime/turnDiffTracker.js';

/**
 * 基础设施端口切片（G25 收尾，2026-10-04 第三十轮搬入 ports）。
 *
 * 原 `CorePorts` 声明在组合根实现文件 `config/corePortsAssembler.ts` 里，且 `spiller`/`discovery`/
 * `hooks`/`turnDiffTracker` 四个成员绑定**实现类**（`ToolResultSpiller`/`ToolDiscovery`/
 * `ToolHookRunner`/`TurnDiffTracker`）——端口契约被绑死在具体类型上。升级报告 §4 登记的
 * 「剩余 4 成员配置子环」中 `SubagentPortSeed`/`MediaStack`/`ResolvedMediaOptions` 已于 G25-b
 * 前后进 ports，本片是最后一块：成员全部改挂**端口契约**（`ToolResultSpillerPort` /
 * `ToolDiscoveryPort` / `ToolHookRunnerPort` / `TurnDiffTrackerPort`，实现类逐一 `implements`），
 * 声明搬入 ports 后 `config/**` 仅依赖契约，原位置只保留桶再导出（公共 API 面不变）。
 *
 * 均为「会话无关」的通用端口——沙箱/审批/外溢/事件/待办/计划/检索/提权/变更追踪。
 */
export interface CorePorts {
  readonly sandbox: SandboxPort;
  readonly approvals: ApprovalPort;
  readonly spill: SpillPort;
  readonly spiller: ToolResultSpillerPort;
  readonly events: EventPort;
  readonly todo: TodoPort;
  readonly plan: PlanPort;
  readonly userResponder: UserResponder;
  readonly planMode: boolean;
  readonly discovery: ToolDiscoveryPort;
  readonly retrieval: RetrievalPort;
  readonly escalation: EscalationPort;
  readonly elevatedSandbox: SandboxPort;
  /** 回合级变更追踪开关（#M5，默认开）：关闭时既不追踪也不产事件。 */
  readonly turnDiff: boolean;
  /** 回合级变更追踪器（#M5）：`turnDiff` 关闭时为 undefined。 */
  readonly turnDiffTracker: TurnDiffTrackerPort | undefined;
  /** 工具钩子运行器（#M5）：无追踪需求时为 undefined。 */
  readonly hooks: ToolHookRunnerPort | undefined;
}
