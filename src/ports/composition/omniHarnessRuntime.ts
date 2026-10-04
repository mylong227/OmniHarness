import type { ResolvedConfig } from '../config/resolvedConfig.js';

import type { ModelPort } from '../model/model.js';
import type { ToolPort } from '../tool/tool.js';
import type { StoragePort } from '../memory/storage.js';
import type { EventPort } from '../runtime/eventPort.js';
import type { SandboxPort } from '../runtime/sandbox.js';
import type { ApprovalPort } from '../runtime/approval.js';
import type { EscalationPort } from '../runtime/escalation.js';
import type { ToolGatePort } from '../runtime/toolGatePort.js';
import type { SupervisorPort } from '../runtime/supervisor.js';
import type { ToolResultSpillerPort } from '../context/toolResultSpillerPort.js';
import type { ToolDiscoveryPort } from '../tool/toolDiscoveryPort.js';
import type { RetrievalPort } from '../intelligence/retrieval.js';
import type { TurnDiffTrackerPort } from '../runtime/turnDiffTracker.js';
import type { ToolHookRunnerPort } from '../tool/toolHookRunnerPort.js';
import type { LongTermMemoryPort } from '../memory/longTermMemory.js';
import type { CosmicWebPort } from '../memory/cosmicWeb.js';
import type { MemoryExtractorPort } from '../memory/memoryExtractor.js';
import type { ContainerPort } from '../runtime/containerPort.js';
import type { NativeToolRunner } from '../../native/nativeBackend.js';
import type { ToolInputSink } from '../tool/toolInputSink.js';
import type { EmbeddingPort } from '../model/embedding.js';
import type { EvolutionController } from '../runtime/evolution.js';
import type { BudgetDegradeSignal } from '../model/budgetDegrade.js';
import type { CompletionGateFactory } from '../runtime/completionGate.js';
import type { SparkController } from '../../spark/sparkController.js';
import type { A2aServer, A2aClient } from '../../a2a/index.js';
import type { A2aTransport } from '../../a2a/a2aProtocol.js';

/**
 * OmniHarness 运行时契约（端口注入版）。
 *
 * 原 `composition/runtime.ts` 中的 `OmniHarnessRuntime` 接口在 `--queue` 解耦收尾时外迁到
 * `ports/composition`，以便 `ports` 层不再隐式耦合 `core`/`adapters` 的具体实现类型。字段类型
 * 已统一为端口契约（`ToolGatePort` / `ContainerPort` / `TurnDiffTrackerPort` / `ToolHookRunnerPort` 等），
 * 仅保留 `context` / `search` / `native` / `spark` / `a2a` 等非禁域类型。
 */
export interface OmniHarnessRuntime {
  /** 已解析配置（端口注入版）。 */
  readonly config: ResolvedConfig;
  /** 模型端口。 */
  readonly model: ModelPort;
  /** 工具端口。 */
  readonly tools: ToolPort;
  /** 存储端口（记忆 / 状态持久化）。 */
  readonly storage: StoragePort;
  /** 事件总线端口。 */
  readonly events: EventPort;
  /** 沙箱端口（命令执行隔离）。 */
  readonly sandbox: SandboxPort;
  /** 审批端口（#77 计划门禁 / 沙箱联动）。 */
  readonly approvals: ApprovalPort;
  /** 升级审批端口（#G3/G4）：沙箱拒绝时咨询，决定是否提权重试。 */
  readonly escalation: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，默认无沙箱）：escalate 裁决后以此复核放行。 */
  readonly elevatedSandbox: SandboxPort;
  /** 统一门禁（审批 + 沙箱 + 计划态，#77 计划门禁在此生效）：StepRunner 与 run_code 共用。 */
  readonly gate: ToolGatePort;
  /** 航天级监督内核（I-P0-3）：健康监控 + Safe mode 分级降级，运行时装配注入主循环。 */
  readonly supervisor?: SupervisorPort | undefined;
  /** 工具结果外溢器（#74）：超大输出落后端，只留有界预览。 */
  readonly spiller: ToolResultSpillerPort;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，StepRunner 据此装载延迟加载工具。 */
  readonly discovery: ToolDiscoveryPort;
  /** 检索端口（#M2）：会话历史事件索引供 memory_search 检索，实现跨长对话 recall。 */
  readonly retrieval: RetrievalPort;
  /** 回合级变更追踪器（#M5）：回合结束时产出 unified diff；关闭时为 undefined。 */
  readonly turnDiff?: TurnDiffTrackerPort | undefined;
  /** 工具钩子运行器（#M5）：变更追踪钩子在此注册，由 StepRunner 执行。 */
  readonly hooks?: ToolHookRunnerPort | undefined;
  /** 长期记忆端口（#S28）：跨会话持久 fact 存储，recall 工具与回合末蒸馏共用。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** 宇宙网记忆引擎（U1 默认开时为 ResonantFieldEngine 单一状态源，实现 CosmicWebPort）：供 runtime 直接驱动 consolidate。 */
  readonly web?: CosmicWebPort | undefined;
  /** 长期记忆蒸馏器（#S28，可选）：模型存在且未关自动沉淀时非空，回合末由 TurnRunner 调用。 */
  readonly memoryExtractor?: MemoryExtractorPort | undefined;
  /** 服务容器端口（组合根注册中心，供自定义扩展查询）。 */
  readonly container: ContainerPort;
  /** 原生后端（FFI #66）：非空时工具执行路由到 Rust 内核；内核不可用则置空以回退 TS 路径。 */
  readonly native?: NativeToolRunner | undefined;
  /**
   * 工具输入实时观察端口（#B3）：模型流式生成的工具参数增量经此端口推给 UI。
   * 可选；子代理等不需实时渲染的场景留空（undefined → StepRunner 走 generate 路径）。
   */
  readonly live?: ToolInputSink | undefined;
  /**
   * 语义嵌入端口（U3 混合检索，可选）：注入后 repo-map 走「BM25 ∪ 语义向量 RRF」混合路径。
   * 由 ConfigFactory 在 env OMNI_SEMANTIC_RECALL=1 时构造并注入；默认 undefined（纯 BM25、零开销）。
   */
  readonly embedding?: EmbeddingPort | undefined;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省 undefined，零破坏。 */
  readonly evolution?: EvolutionController | undefined;
  /**
   * 预算降级信号端口（P5 自动降档，可选）：由 ConfigFactory 桥 `costBudget` 注入；非空时
   * `StepContextBuilder` 在软阈值越过后收敛检索预算（缩 fileK / 关语义路）。缺省 undefined，零破坏。
   */
  readonly budgetDegrade?: BudgetDegradeSignal | undefined;
  /**
   * 回合完成闸门工厂（A1 收口，可选）：由组合根注入实现（核心只认端口），`Agent` 每个回合调用一次
   * 决定本回合用哪种闸门。缺省 undefined＝不设闸门（旧行为；子代理运行时即如此）。
   */
  readonly completionGateFactory?: CompletionGateFactory | undefined;
  /** 燧内核控制器（S+，可选）：任一燧能力启用时构造，Agent 任务末跑 燧-3/燧-4 调谐/冲刷；缺省 undefined，零破坏。 */
  readonly spark?: SparkController | undefined;
  /** (U6) A2A 互操作：启用时本端起 A2aServer（监听）并构造 A2aClient，server 任务处理器跑子 agent 完成对等委托。缺省 undefined，零破坏。 */
  a2a?: {
    /** A2A 服务端（监听对等委托）。 */
    readonly server: A2aServer;
    /** A2A 客户端（发起对等委托）。 */
    readonly client: A2aClient;
    /** A2A 传输（http / ws 实现同一 `A2aTransport` 端口）。 */
    readonly transport: A2aTransport;
  };
}
