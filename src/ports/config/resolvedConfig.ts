import type { OmniHarnessConfig } from './omniHarnessConfig.js';

import type { ApprovalPort } from '../runtime/approval.js';
import type { SandboxPort } from '../runtime/sandbox.js';
import type { EventPort } from '../runtime/eventPort.js';
import type { UserResponder } from '../runtime/userResponder.js';
import type { TodoPort } from '../runtime/todo.js';
import type { PlanPort } from '../runtime/plan.js';
import type { RetrievalPort } from '../intelligence/retrieval.js';
import type { EscalationPort } from '../runtime/escalation.js';
import type { TurnDiffTrackerPort } from '../runtime/turnDiffTracker.js';
import type { ToolHookRunnerPort } from '../tool/toolHookRunnerPort.js';
import type { ToolPort } from '../tool/tool.js';
import type { SpillPort } from '../memory/spill.js';
import type { ToolResultSpillerPort } from '../context/toolResultSpillerPort.js';
import type { ToolDiscoveryPort } from '../tool/toolDiscoveryPort.js';
import type { LongTermMemoryPort } from '../memory/longTermMemory.js';
import type { RepoMapContextEnginePort } from '../context/repoMapContextEnginePort.js';
import type { ScratchpadPort } from '../memory/scratchpad.js';
import type { MemoryExtractorPort } from '../memory/memoryExtractor.js';
import type { CostBudgetPort } from '../model/costBudgetPort.js';
import type { BudgetDegradeSignal } from '../model/budgetDegrade.js';
import type { LspPort } from '../tool/lsp.js';
import type { AgentIdentityPort } from '../runtime/agentIdentity.js';
import type { ToolInputSink } from '../tool/toolInputSink.js';
import type { EmbeddingPort } from '../model/embedding.js';
import type { EvolutionController } from '../runtime/evolution.js';
import type { SparkController } from '../../spark/sparkController.js';
import type { MemoryAnnealer } from '../memory/memoryAnnealing.js';
import type { CosmicWebPort } from '../memory/cosmicWeb.js';
import type { QECEncoderPort } from '../intelligence/qec/qecEncoderPort.js';
import type { ImmuneMonitorPort } from '../intelligence/immune/immuneMonitorPort.js';
import type { MetacognitionPort } from '../intelligence/metacognition/metacognitionPort.js';
import type { CRISPRSkillEditorPort } from '../runtime/skillEdit/crisprSkillEditorPort.js';
import type { CapabilityCrystallizerPort } from '../intelligence/capability/capabilityCrystallizerPort.js';
import type { InsightEtchingPort } from '../memory/insightEtching/insightEtchingPort.js';
import type { ElementComposerPort } from '../intelligence/elementComposer/elementComposerPort.js';
import type { SymmetryBreakingPort } from '../intelligence/symmetryBreaking/symmetryBreakingPort.js';
import type { ConfinementPort } from '../runtime/confinement/confinementPort.js';
import type { SkillRegistry } from '../../skill/skillRegistry.js';

/**
 * 已解析配置契约（端口注入版）。
 *
 * 原 `configFactory.ts` 中的 `ResolvedConfig` 接口在 `--queue` 解耦收尾时外迁到 `ports/config`，
 * 以便 `ports` 层不再隐式耦合 `core`/`adapters` 的具体实现类型。字段类型已统一为端口契约
 * （`TurnDiffTrackerPort` / `ToolHookRunnerPort` / `CostBudgetPort` / 各仿生引擎端口 / `ToolGatePort` 等），
 * 仅保留 `context` / `search` / `skill` / `spark` 等非禁域类型（`ResolvedConfig` 的 `extends`
 * 源 `OmniHarnessConfig` 同样位于 `ports/config`，故无 `ports→config` 反向依赖）。
 */
export interface ResolvedConfig extends OmniHarnessConfig {
  /** 审批端口（#77 计划门禁 / 沙箱联动）。 */
  readonly approvals: ApprovalPort;
  /** 沙箱端口（命令执行隔离）。 */
  readonly sandbox: SandboxPort;
  /** 事件总线端口（跨组件事件广播，如回合级变更事件）。 */
  readonly events: EventPort;
  /** 工具端口（工具集入口）。 */
  readonly tools: ToolPort;
  /** 记忆封包溢出端口（超阈值记忆经此落盘）。 */
  readonly spill: SpillPort;
  /** 工具结果外溢器（#74）：超大输出落后端，只留有界预览。 */
  readonly spiller: ToolResultSpillerPort;
  /** 是否处于计划模式（plan-only，不执行副作用工具）。 */
  readonly planMode: boolean;
  /** Agent 用户响应端口（进度 / 澄清提问推送）。 */
  readonly userResponder: UserResponder;
  /** 待办清单端口。 */
  readonly todo: TodoPort;
  /** 计划端口（多步规划态）。 */
  readonly plan: PlanPort;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，使延迟加载工具后续回合对模型可见。 */
  readonly discovery: ToolDiscoveryPort;
  /** 检索端口（#M2）：会话历史事件索引供 memory_search 检索，实现跨长对话 recall。 */
  readonly retrieval: RetrievalPort;
  /** 升级审批端口（#G3/G4）：沙箱拒绝时咨询，决定是否提权重试（fail-closed 默认不提权）。 */
  readonly escalation: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，默认 policy=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦。 */
  readonly elevatedSandbox: SandboxPort;
  /** 回合级变更追踪器（#M5）：关闭时为 undefined，不追踪也不产事件。与 `OmniHarnessConfig.turnDiff`（布尔开关）区分命名，避免类型冲突。 */
  readonly turnDiffTracker?: TurnDiffTrackerPort | undefined;
  /** 工具钩子运行器（#M5）：变更追踪钩子注册于此；无追踪需求时为 undefined。 */
  readonly hooks?: ToolHookRunnerPort | undefined;
  /** 长期记忆端口（#S28）：跨会话持久 fact 存储，默认文件落盘；recall 工具与回合末蒸馏共用。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** repo-map 上下文引擎（P2.2 单例收敛）：组合根唯一构造点，注入 StepRunnerDeps。 */
  readonly repoMapContext: RepoMapContextEnginePort;
  /** 跨重置便签（T3.4）：重置后读回交接物恢复任务。 */
  readonly scratchpad: ScratchpadPort;
  /** 长期记忆蒸馏器（#S28，可选）：模型存在且未关 memoryConsolidate 时构造，回合末自动沉淀；否则 undefined（仅支持显式 remember）。 */
  readonly memoryExtractor?: MemoryExtractorPort | undefined;
  /** 成本预算计量（#S29，可选）：配置 costBudgetUsd 正数时构造，BudgetedModel 与 budget_status 工具共享同一实例（含子代）。 */
  readonly costBudget?: CostBudgetPort | undefined;
  /**
   * 预算降级信号端口（P5 自动降档，可选）：仅当 `costBudget` 存在时桥接构造，供 `core`
   * 消费点（`StepContextBuilder`）在软阈值越过后收敛检索预算。缺省（无预算）为 undefined
   * ⇒ 消费点 `?.shouldDegrade` 恒 false，零行为变更。建模为端口是为守住 `core → adapters` 架构红线。
   */
  readonly budgetDegrade?: BudgetDegradeSignal | undefined;
  /** 自主目标循环最大迭代次数（#S30，默认 10，CLI/工具可覆盖）。 */
  readonly goalMaxIterations: number;
  /** LSP 代码导航端口（#S32，可选）：配置了 lsp 服务器时构造 LspProcessAdapter，否则 undefined（LSP 工具不注册）。 */
  readonly lsp?: LspPort | undefined;
  /** Agent 密码学身份端口（#S33，可选）：配置了 agentIdentity 时构造 Ed25519AgentIdentity，否则 undefined（agent_identity 工具不注册）。 */
  readonly identity?: AgentIdentityPort | undefined;
  /** 工具输入实时观察端口（#B3，可选）：模型流式生成的工具参数增量经此推给 UI；由 ConfigFactory 默认 ConsoleLiveView。 */
  readonly live?: ToolInputSink | undefined;
  /** 语义嵌入端口（U3 混合检索，可选）：env OMNI_SEMANTIC_RECALL=1 时由 ConfigFactory 构造并注入本地 ONNX 嵌入适配器；默认 undefined（纯 BM25、零开销）。 */
  readonly embedding?: EmbeddingPort | undefined;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省不启用，零破坏。 */
  readonly evolution?: EvolutionController | undefined;
  /** 燧内核控制器（S+，可选）：任一燧能力启用时构造，Agent 任务完成后可在 fail-closed 下跑 燧-3/燧-4 调谐/冲刷/(D) 退火/(E) 宇宙网/QEC/免疫；缺省不启用，零破坏。 */
  readonly spark?: SparkController | undefined;
  /** (D) 热方程记忆退火器（memoryAnnealing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly annealer?: MemoryAnnealer | undefined;
  /** (E, I-P1-2) 宇宙网记忆端口（U1 默认开时即 ResonantField 单一状态源，实现 CosmicWebPort，注入 spark）；缺省 undefined，零破坏。 */
  readonly web?: CosmicWebPort | undefined;
  /** (E, I-P1-3) QEC 记忆编码器（qec.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly qecEncoder?: QECEncoderPort | undefined;
  /** (E, I-P1-5) 免疫异常监控器（immuneMonitoring.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly immune?: ImmuneMonitorPort | undefined;
  /** (P2, I-P2-2) 自然梯度信念引擎（belief 启用且 algorithm 含 natural-gradient 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly naturalGradient?: MetacognitionPort | undefined;
  /** (P2, I-P2-3) 粒子滤波信念引擎（belief 启用且 algorithm 含 particle-filter 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly particleFilter?: MetacognitionPort | undefined;
  /** (P2, I-P2-4/5) 受种技能注册表：CRISPR 编辑面 / 相变固化组合解析面；同时可注入 Agent 增强技能匹配。 */
  readonly skillRegistry: SkillRegistry;
  /** (P2, I-P2-4) CRISPR 精确技能编辑器（skillEditing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crispr?: CRISPRSkillEditorPort | undefined;
  /** (P2, I-P2-5) 相变固化器（capabilityCrystallization.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** (P3, I-P3-1) 刻蚀记忆引擎（insightEtching.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly etching?: InsightEtchingPort | undefined;
  /** (P3, I-P3-2) 元素组合基元引擎（elementComposer.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly elementComposerEngine?: ElementComposerPort | undefined;
  /** (P3, I-P3-3) 对称破缺引擎（symmetryBreaking.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly symmetry?: SymmetryBreakingPort | undefined;
  /** (P3, I-P3-4) 禁闭色荷引擎（confinement.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly confinementEngine?: ConfinementPort | undefined;
}
