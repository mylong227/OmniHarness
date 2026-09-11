import type { ApprovalPort } from '../ports/approval.js';
import type { EventPort } from '../ports/eventPort.js';
import type { SandboxPort } from '../ports/sandbox.js';
import type { SpillPort } from '../ports/spill.js';
import type { RetrievalPort } from '../ports/retrieval.js';
import type { EscalationPort } from '../ports/escalation.js';
import type { TodoPort } from '../ports/todo.js';
import type { PlanPort } from '../ports/plan.js';
import type { UserResponder } from '../ports/userResponder.js';

import { ConsoleEventPort } from '../adapters/event/consoleEventPort.js';
import { PassthroughSandbox } from '../adapters/sandbox/passthroughSandbox.js';
import { PolicySandbox } from '../adapters/sandbox/policySandbox.js';
import { DenyEscalation } from '../adapters/escalation/denyEscalation.js';
import { Bm25MemoryIndex } from '../adapters/retrieval/bm25MemoryIndex.js';
import { MemoryTodo } from '../adapters/todo/memoryTodo.js';
import { MemoryPlan } from '../adapters/plan/memoryPlan.js';
import { ToolResultSpiller } from '../context/toolResultSpiller.js';
import { TurnDiffTracker } from '../core/turnDiffTracker.js';
import type { ToolHookRunner } from '../core/toolHooks.js';
import { ToolDiscovery } from '../search/toolDiscovery.js';
import { VortexRingPacket, VortexRingSpillAdapter } from '../adapters/spill/vortexRing.js';

import { autoUserResponder, buildApprovals, buildHooks, buildSpill } from './configBuilders.js';
import type { OmniHarnessConfig } from './omniharnessConfig.js';

/** Spill 默认参数（#74：超大工具输出外溢，避免撑爆上下文）。 */
const DEFAULT_SPILL_MAX_INLINE_BYTES = 16384;
const DEFAULT_SPILL_PREVIEW_BYTES = 2048;

/**
 * 基础设施端口切片：直接并入 `ResolvedConfig` 的字段子集。
 * 均为「会话无关」的通用端口——沙箱/审批/外溢/事件/待办/计划/检索/提权/变更追踪。
 */
export interface CorePorts {
  readonly sandbox: SandboxPort;
  readonly approvals: ApprovalPort;
  readonly spill: SpillPort;
  readonly spiller: ToolResultSpiller;
  readonly events: EventPort;
  readonly todo: TodoPort;
  readonly plan: PlanPort;
  readonly userResponder: UserResponder;
  readonly planMode: boolean;
  readonly discovery: ToolDiscovery;
  readonly retrieval: RetrievalPort;
  readonly escalation: EscalationPort;
  readonly elevatedSandbox: SandboxPort;
  /** 回合级变更追踪开关（#M5，默认开）：关闭时既不追踪也不产事件。 */
  readonly turnDiff: boolean;
  /** 回合级变更追踪器（#M5）：`turnDiff` 关闭时为 undefined。 */
  readonly turnDiffTracker: TurnDiffTracker | undefined;
  /** 工具钩子运行器（#M5）：无追踪需求时为 undefined。 */
  readonly hooks: ToolHookRunner | undefined;
}

/** 基础设施端口的装配结果：切片 + 燧专用内部件。 */
export interface CorePortsAssembly {
  /** 并入 `ResolvedConfig` 的端口切片。 */
  readonly ports: CorePorts;
  /** 燧-4 涡环包外溢适配器（`vortexRing.enabled` 时非空，供 SparkController 冲刷持环）。 */
  readonly vortex: VortexRingSpillAdapter | undefined;
}

/**
 * 装配基础设施端口切片（组合根一侧）。
 *
 * 把「沙箱 → 审批 → 外溢 → 事件/待办/计划/检索/提权 → 变更追踪」这条与具体能力无关的
 * 通用装配链收敛为单次调用，供 `ConfigFactory` 编排。所有默认实现取「fail-closed」最保守侧
 * （提权复核沙箱默认 policy 收紧），需真正全权时由调用方显式覆盖。
 *
 * @param partial 未解析的运行配置（用户注入优先，缺省落内置实现）。
 * @returns 端口切片 + 涡环包适配器（未启用时为 undefined）。
 */
export function assembleCorePorts(partial: OmniHarnessConfig): CorePortsAssembly {
  const sandbox = partial.sandbox ?? new PassthroughSandbox();
  const approvals = buildApprovals(partial, sandbox);
  let spill = buildSpill(partial);
  // 燧-4 涡环包（S+）：启用时把外溢端口封成拓扑环包；必须在 spiller 构造前封好，
  // 使主循环全部"超大输出外溢"自动走拓扑孤子传输（fail-closed 抗污染、不随内容膨胀）。
  let vortex: VortexRingSpillAdapter | undefined;
  if (partial.vortexRing?.enabled === true) {
    vortex = new VortexRingSpillAdapter(new VortexRingPacket(spill));
    spill = vortex;
  }
  const spiller = new ToolResultSpiller(spill, {
    maxInlineBytes: partial.spillMaxInlineBytes ?? DEFAULT_SPILL_MAX_INLINE_BYTES,
    previewBytes: partial.spillPreviewBytes ?? DEFAULT_SPILL_PREVIEW_BYTES,
  });
  const turnDiff = partial.turnDiff !== false;
  const turnDiffTracker = turnDiff ? new TurnDiffTracker() : undefined;
  return {
    ports: {
      sandbox,
      approvals,
      spill,
      spiller,
      events: partial.events ?? new ConsoleEventPort(),
      todo: partial.todo ?? new MemoryTodo(),
      plan: partial.plan ?? new MemoryPlan(),
      userResponder: partial.userResponder ?? autoUserResponder(),
      planMode: partial.planMode ?? false,
      discovery: new ToolDiscovery(),
      retrieval: partial.retrieval ?? new Bm25MemoryIndex(),
      escalation: partial.escalation ?? new DenyEscalation(),
      // #G3/G4 提权复核沙箱：默认 policy（fail-closed 收紧）——escalate 后仍拦截危险命令/工作区外路径，
      // 杜绝「启用 auto/ask 提权即静默全放行」的 fail-open；需真正全权时显式 --elevated-sandbox passthrough。
      elevatedSandbox:
        partial.elevatedSandbox ?? new PolicySandbox({ workspaceRoot: partial.workspaceRoot }),
      turnDiff,
      turnDiffTracker,
      hooks:
        turnDiffTracker === undefined ? undefined : buildHooks(turnDiffTracker, partial.workspaceRoot),
    },
    vortex,
  };
}
