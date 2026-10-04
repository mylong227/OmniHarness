import { ConsoleEventPort } from '../adapters/event/consoleEventPort.js';
import { TraceExporterAssembly } from '../observability/traceExporterAssembly.js';
import { PolicySandbox } from '../adapters/sandbox/policySandbox.js';
import { DenyEscalation } from '../adapters/escalation/denyEscalation.js';
import { Bm25MemoryIndex } from '../adapters/retrieval/bm25MemoryIndex.js';
import { MemoryTodo } from '../adapters/todo/memoryTodo.js';
import { MemoryPlan } from '../adapters/plan/memoryPlan.js';
import { ToolResultSpiller } from '../context/toolResultSpiller.js';
import { TurnDiffTracker } from '../core/turnDiffTracker.js';
import { ToolDiscovery } from '../search/toolDiscovery.js';
import {
  VortexRingPacket,
  VortexRingSpillAdapter,
  DEFAULT_SPILL_MAX_RINGS,
} from '../adapters/spill/vortexRingSpillAdapter.js';

import { ConfigBuilder } from './configBuilder.js';
import type { OmniHarnessConfig } from '../ports/config/omniHarnessConfig.js';
import type { CorePorts } from '../ports/config/corePorts.js';

/** 原 `CorePorts` 声明已搬入 `ports/config/corePorts.ts`（G25 收尾，契约归 ports）；此处桶再导出保持公共 API 面不变。 */
export type { CorePorts } from '../ports/config/corePorts.js';

/**
 * CorePortsAssembler —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class CorePortsAssembler {
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
  public static assembleCorePorts(partial: OmniHarnessConfig): CorePortsAssembly {
    // 沙箱默认取 **policy** 而非 passthrough：passthrough 是「不做任何隔离」的对照实现，
    // 把它当缺省会让编程式调用方（`ConfigFactory` 未显式注入 sandbox 时）在全无门禁的状态下
    // 执行 shell/写文件，与「fail-closed 最保守侧」的装配原则自相矛盾（2026-10-01 审计）。
    // CLI 侧早已默认 `policy`（`argParser.ts`），此处把组合根对齐到同一最保守侧；
    // 确需零隔离的调用方仍可显式传入 `new PassthroughSandbox()`。
    const sandbox = partial.sandbox ?? new PolicySandbox({ workspaceRoot: partial.workspaceRoot });
    const approvals = ConfigBuilder.buildApprovals(partial, sandbox);
    let spill = ConfigBuilder.buildSpill(partial);
    // 燧-4 涡环包（S+）：启用时把外溢端口封成拓扑环包；必须在 spiller 构造前封好，
    // 使主循环全部"超大输出外溢"自动走拓扑孤子传输（fail-closed 抗污染、不随内容膨胀）。
    let vortex: VortexRingSpillAdapter | undefined;
    if (partial.vortexRing?.enabled === true) {
      vortex = new VortexRingSpillAdapter(new VortexRingPacket(spill), {
        maxRings: partial.spillMaxRings ?? DEFAULT_SPILL_MAX_RINGS,
      });
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
        // 可观测性接线（OTLP）：设了 OTEL_EXPORTER_OTLP_ENDPOINT 才包一层 span 收集器，
        // 否则**原样返回**（零行为变更）。CLI / 服务端 / 子代理共用本装配点，故一处接线全覆盖。
        events: TraceExporterAssembly.wrap(partial.events ?? new ConsoleEventPort()),
        todo: partial.todo ?? new MemoryTodo(),
        plan: partial.plan ?? new MemoryPlan(),
        userResponder: partial.userResponder ?? ConfigBuilder.autoUserResponder(),
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
          turnDiffTracker === undefined
            ? undefined
            : ConfigBuilder.buildHooks(turnDiffTracker, partial.workspaceRoot),
      },
      vortex,
    };
  }
}

/** Spill 默认参数（#74：超大工具输出外溢，避免撑爆上下文）。 */
const DEFAULT_SPILL_MAX_INLINE_BYTES = 16384;
const DEFAULT_SPILL_PREVIEW_BYTES = 2048;

/** 基础设施端口的装配结果：切片 + 燧专用内部件。 */
export interface CorePortsAssembly {
  /** 并入 `ResolvedConfig` 的端口切片。 */
  readonly ports: CorePorts;
  /** 燧-4 涡环包外溢适配器（`vortexRing.enabled` 时非空，供 SparkController 冲刷持环）。 */
  readonly vortex: VortexRingSpillAdapter | undefined;
}
