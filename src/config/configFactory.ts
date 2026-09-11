import type { ApprovalPort } from '../ports/approval.js';
import type { ToolInputSink } from '../ports/toolInputSink.js';
import type { EventPort } from '../ports/eventPort.js';
import type { ModelPort, RoutePrice } from '../ports/model.js';
import { CostBudget } from '../adapters/model/costBudget.js';
import { mergeRoutePricing, DEFAULT_FALLBACK_PRICE } from '../adapters/model/routePricing.js';

import type { ModelRouterConfig } from './configFile.js';
import type { SandboxPort } from '../ports/sandbox.js';
import type { StoragePort } from '../ports/storage.js';
import type { RetrievalPort } from '../ports/retrieval.js';
import type { EscalationPort } from '../ports/escalation.js';
import type { SpillPort } from '../ports/spill.js';
import type { ToolDefinition, ToolPort } from '../ports/tool.js';
import type { ToolHandler } from '../adapters/tool/toolHandler.js';
import type { TurnDiffTracker } from '../core/turnDiffTracker.js';
import type { ToolHookRunner } from '../core/toolHookRunner.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import type { LongTermMemoryPort } from '../ports/longTermMemory.js';
import type { MemoryExtractor } from '../adapters/memory/memoryExtractor.js';
import type { CosmicWebPort } from '../ports/cosmicWeb.js';
import type { MemoryAnnealer } from '../ports/memoryAnnealing.js';
import type { QECEncoder } from '../adapters/memory/qecEncoder.js';
import type { ImmuneMonitor } from '../adapters/monitoring/immuneMonitor.js';
import type { NaturalGradientBelief } from '../adapters/belief/naturalGradientBelief.js';
import type { ParticleFilterBelief } from '../adapters/belief/particleFilterBelief.js';
import type { CRISPRSkillEditor } from '../adapters/skill/crisprSkillEditor.js';
import type { CapabilityCrystallizer } from '../adapters/skill/capabilityCrystallizer.js';
import type { InsightEtchingEngine } from '../adapters/memory/insightEtchingEngine.js';
import type { ElementComposer } from '../adapters/skill/elementComposer.js';
import type { SymmetryBreakingEngine } from '../adapters/monitoring/symmetryBreakingEngine.js';
import type { ConfinementEngine } from '../adapters/monitoring/confinementEngine.js';
import type { SkillRegistry } from '../skill/skillRegistry.js';
import type { RuntimeTelemetryPort } from '../ports/runtimeTelemetry.js';
import type { Skill } from '../skill/skill.js';
import type { SparkController } from '../spark/sparkController.js';
import type { ToolDiscovery } from '../search/toolDiscovery.js';
import type { WorkerRegistry } from '../worker/workerRegistry.js';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../autonomy/goalRunner.js';

import type { LspPort, LspServerConfig } from '../ports/lsp.js';
import type { AgentIdentityConfig, AgentIdentityPort } from '../ports/agentIdentity.js';
import type { SubagentPorts } from '../subagent/subagentPorts.js';
import type { SubagentOptions } from '../subagent/subagentTypes.js';
import type { UserResponder } from '../ports/userResponder.js';
import type { TodoPort } from '../ports/todo.js';
import type { PlanPort } from '../ports/plan.js';
import type { EvolutionController } from '../ports/evolution.js';
import type { RegimeSignals } from '../genesis/operators.js';

import { buildIdentity, buildLsp, buildModel, seedOf } from './configBuilder.js';
import { defaultTools } from './configToolRegistry.js';
import { assembleCorePorts } from './corePortsAssembler.js';
import { assembleMemoryStack } from './memoryStackAssembler.js';
import { assembleSkillStack } from './skillStackAssembler.js';
import { assembleSpark } from './sparkAssembler.js';

/** OmniHarness运行时配置：端口注入即插即用，核心零依赖具体实现。 */
export interface OmniHarnessConfig {
  readonly workspaceRoot: string;
  readonly maxSteps: number;
  /** 回合 token 预算（V2.1 / B4，可选）：累计模型 usage 超限即停止步进交由总结收尾。0/缺省关闭。 */
  readonly turnTokenBudget?: number;
  readonly model: ModelPort;
  readonly storage: StoragePort;
  readonly approvals?: ApprovalPort;
  /** 推理强度（#B6，可选）：minimal / low / medium / high / xhigh，透传为模型 reasoning_effort。 */
  readonly reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly sandbox?: SandboxPort;
  readonly events?: EventPort;
  readonly tools?: ToolPort;
  readonly extraTools?: readonly ExtraTool[];
  readonly compactionMaxTokens?: number;
  readonly compactionKeepRecent?: number;
  /** 自定义外溢端口（不传用内置实现）。 */
  readonly spill?: SpillPort;
  /** 内置外溢后端：file（落盘，跨重启可恢复，默认）| memory（进程内）。 */
  readonly spillAdapter?: 'memory' | 'file';
  /** 文件外溢目录（相对 workspaceRoot，默认 .omniharness/spill）。 */
  readonly spillDir?: string;
  /** 输出超过此字节数触发外溢（默认 16384）。 */
  readonly spillMaxInlineBytes?: number;
  /** 外溢后保留的预览字节数（默认 2048）。 */
  readonly spillPreviewBytes?: number;
  readonly workers?: WorkerRegistry;
  /** 子智能体最大派生深度（默认 2：允许 1 层子智能体，depth >= 该值即拒绝）。 */
  readonly subagentMaxDepth?: number;
  /** 子智能体并发上限（默认 4）。 */
  readonly subagentConcurrency?: number;
  /** 单个子智能体的步数上限（默认 12）。 */
  readonly subagentMaxSteps?: number;
  readonly fragments?: readonly string[];
  /** 启用 FFI 原生后端（#66）：工具执行路由到 Rust 内核 in-process；内核不可用时静默回退 TS。 */
  readonly native?: boolean;
  /** 计划模式（#77）：开启后未批准计划前，ToolGate 拦截所有写类工具（探索/提问/计划类可用）。 */
  readonly planMode?: boolean;
  /** 自定义用户回答端口（不传按 TTY 自动选 Console/Default）。 */
  readonly userResponder?: UserResponder;
  /** 自定义待办端口（不传用内存实现）。 */
  readonly todo?: TodoPort;
  /** 自定义计划端口（不传用内存实现）。 */
  readonly plan?: PlanPort;
  /** 延迟加载工具名清单（#M1）：列出的工具默认不注入模型上下文，需经 tool_search 发现后可见（省上下文）。 */
  readonly deferredTools?: readonly string[];
  /** 自定义检索端口（#M2，缺省用内存 BM25）。会话历史事件经记录器索引后供 memory_search 检索。 */
  readonly retrieval?: RetrievalPort;
  /** 升级审批端口（#G3/G4，缺省 DenyEscalation=fail-closed 不提权）。沙箱拒绝时咨询，决定是否提权重试。 */
  readonly escalation?: EscalationPort;
  /** 提权后的复核沙箱（缺省 PolicySandbox=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦。 */
  readonly elevatedSandbox?: SandboxPort;
  /** 审批缓存（#M4，默认关）：开启后同一「工具 + 规范化命令 + cwd + 策略指纹」只问一次。 */
  readonly approvalCache?: boolean;
  /** 审批缓存上限（#M4，默认 256）：超出按 LRU 淘汰。 */
  readonly approvalCacheMaxEntries?: number;
  /** 智能模型路由（#B4，可选）：配置后以 ModelRouter 替换默认 model 适配器，按策略在 entries 间路由（fail-closed）。 */
  readonly modelRouter?: ModelRouterConfig;
  /** 模型调用重试（#M6，默认关）：开启后对 429/5xx/网络抖动按指数退避自动重试。 */
  readonly modelRetry?: boolean;
  /** 模型重试最大次数（#M6，默认 3，含首次）。 */
  readonly modelRetryMaxAttempts?: number;
  /** 模型重试基础退避毫秒（#M6，默认 500）。 */
  readonly modelRetryBaseDelayMs?: number;
  /** Agent 密码学身份配置（#S33，可选）：声明 Ed25519 私钥（PKCS#8 der base64）与 runtime id；不配则每次运行生成临时身份、且不注册 `agent_identity` 工具。零依赖（仅 Node 内置 node:crypto）。 */
  readonly agentIdentity?: AgentIdentityConfig;
  /** 回合级变更追踪（#M5，默认开）：写类工具前后取样，回合结束广播 unified diff 事件。 */
  readonly turnDiff?: boolean;
  /** 长期记忆（#S28，默认开）：跨会话持久 fact 存储，落盘于 <workspace>/.omniharness/longterm/memory.jsonl；注入自定义实现则覆盖默认文件存储。 */
  readonly longTermMemory?: LongTermMemoryPort;
  /** 长期记忆落盘路径（#S28，默认 <workspace>/.omniharness/longterm/memory.jsonl）。 */
  readonly longTermMemoryPath?: string;
  /** 回合末自动蒸馏沉淀（#S28，默认开）：每回合末用模型把对话蒸馏为持久事实；关掉则仅支持模型显式 remember。 */
  readonly memoryConsolidate?: boolean;
  /** 每回合蒸馏最多沉淀事实数（#S28，默认 8）。 */
  readonly memoryConsolidateMaxFacts?: number;
  /** 长期记忆落盘加密（#4.4 Vault 集成，默认关）：开启后用 AES-256-GCM 逐行加密 memory.jsonl。 */
  readonly longTermMemoryEncryption?: boolean;
  /** 加密密钥文件路径（#4.4）：缺省为 <workspace>/.omniharness/longterm/memory.key，首次使用自动生成。 */
  readonly longTermMemoryKeyFile?: string;
  /** 成本硬预算（#S29，USD）：设正数后按路由定价累计模型花费，越上限即熔断（fail-closed 阻断后续调用）。0 / 不设为关闭。 */
  readonly costBudgetUsd?: number;
  /** 自定义路由定价表（#S29，USD / 百万 token）：键为模型名（精确或前缀匹配），叠在默认表之上。 */
  readonly routePricing?: Record<string, RoutePrice>;
  /** 预算耗尽行为（#S29，默认 'fail'）：'fail' 抛错阻断；'warn' 仅回调不阻断（软预算，仅观测）。 */
  readonly costBudgetOnExceed?: 'fail' | 'warn';
  /** 自主目标循环最大迭代次数（#S30，默认 10）：run_goal 工具与 CLI goal 子命令的默认上限。 */
  readonly goalMaxIterations?: number;
  /** LSP 代码导航服务器配置（#S32，可选）：声明如何启动外部语言服务器；不配则 LSP 工具不注册。零依赖——服务器由用户自备（如 typescript-language-server）。运行时端口见 `ResolvedConfig.lsp`。 */
  readonly lspServer?: LspServerConfig;
  /** 工具输入实时观察端口（#B3，可选）：注入自定义实时视图（TUI / web）以渐进渲染工具参数；不配则由 createRuntime 默认 ConsoleLiveView（TTY 实时刷新）。 */
  readonly live?: ToolInputSink;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省不启用，零破坏。 */
  readonly evolution?: EvolutionController;
  /**
   * (U4 升格) RLVR 进化闭环：启用时运行时自动构造「可验证门禁 + RLVR sample-filter-replay」控制器，
   * 取代/补充 `evolution` 注入。每个过门禁的候选再跑一轮 StarPO 采样→可验证奖励（编译/测试绿度）打分→
   * 绿样本进回放缓冲，仅「绿」样本才晋升。缺省关，零破坏。
   */
  readonly evolutionRlvr?: {
    readonly enabled?: boolean;
    /** 发现预算上限（默认 12）。 */
    readonly maxCandidates?: number;
    /** 每 prompt 采样数（默认 8）。 */
    readonly samplesPerPrompt?: number;
    /** RLVR 最低保留阈值（默认 0）。 */
    readonly minReward?: number;
    /** 候选代码验证命令（含 `%CODE_FILE%` 占位符）。缺省则 RLVR 奖励恒 0（无样本进回放，安全旁路）。 */
    readonly verifyCommand?: string;
    /** 门禁基准增益阈值（默认 0.05）。 */
    readonly minGain?: number;
    /** 任务完成后自动进化（默认 false）。 */
    readonly autoRun?: boolean;
  };
  /** 提示注入护栏（opt-in，默认关）：开启后工具结果进模型上下文前做确定性指令注入扫描，命中即隔离（不喂给模型）。零依赖、纯规则启发式、失败开放（扫描器异常时放行原始结果）。 */
  readonly promptInjectionGuard?: boolean;
  /** 燧-3 共振寻址（S+ 发明层）：启用后长期记忆召回改用频率域共振代数（非 BM25 几何距离），使"市面唯一"寻址维度真进主循环。缺省关，零破坏。 */
  readonly resonance?: { enabled: boolean };
  /** 燧-4 涡环包（S+ 发明层）：启用后工具大输出外溢封成拓扑环包（fail-closed 抗污染、不随内容膨胀）。缺省关，零破坏。 */
  readonly vortexRing?: { enabled: boolean };
  /** 燧内核 autoRun（复用 I-P1-4 进化闭环的 autoRun 钩子）：任务完成后跑一轮 燧-3/燧-4 调谐/冲刷/(D) 退火。缺省关，零破坏。 */
  readonly sparkAutoRun?: boolean;
  /** (D) 热方程记忆重加权 / 退火调度（S+ 知识基础算子）：启用后对长期记忆跑频率域共振耦合的热方程扩散 + 温度退火，使共振簇共识、孤立事实自然遗忘。缺省关，零破坏。 */
  readonly memoryAnnealing?: {
    readonly enabled?: boolean;
    readonly coupling?: number;
    readonly initialTemperature?: number;
    readonly coolingRate?: number;
    readonly decay?: number;
    readonly resonanceThreshold?: number;
    readonly maxFacts?: number;
  };
  /** (E, I-P1-2) 宇宙网记忆：启用后长期记忆自组织成宇宙网——写入走 Burgers 黏附去重、consolidate 走 RG 粗粒化坍缩（Bekenstein 容量界约束、存储不膨胀）。缺省关，零破坏。 */
  readonly memoryWeb?: {
    readonly enabled?: boolean;
    readonly adhesionThreshold?: number;
    readonly bekensteinCap?: number;
  };
  /** (U1) 共振场统一基板：启用后长期记忆走单一 ResonantField 引擎（合并 燧-3 共振寻址 + 宇宙网，消除双重频谱索引），取代分别启用的 resonance + memoryWeb。缺省关，零破坏。 */
  readonly resonantField?: {
    readonly enabled?: boolean;
    readonly adhesionThreshold?: number;
    readonly bekensteinCap?: number;
  };
  /** (U6) A2A 互操作：启用后运行时起 A2aServer（监听端口）并构造 A2aClient，server 任务处理器跑子 agent 完成对等委托（能力胶囊 Ed25519 签名即身份，fail-closed 验签）。缺省关，零破坏。 */
  readonly a2a?: {
    readonly enabled?: boolean;
    /** 服务端监听端口（默认 8790，避开 appServer 8787）。 */
    readonly port?: number;
    /** 本端 client 默认对端端点（委托目标，默认 http://localhost:8790/a2a）。 */
    readonly peerEndpoint?: string;
  };
  /** (E, I-P1-3) QEC 记忆编码器：启用后对长期记忆跑二维奇偶症状编码 + 全量校验，单点 corrupt 自动定位纠正（fail-closed 不静默接受多点损坏）。缺省关，零破坏。 */
  readonly qec?: {
    readonly enabled?: boolean;
    readonly cols?: number;
  };
  /** (E, I-P1-5) 免疫异常监控：启用后训练自体检测器，对记忆健康度等"自体"行为向量周期采样，偏离即告警/隔离（fail-closed，不擅自改写）。缺省关，零破坏。 */
  readonly immuneMonitoring?: {
    readonly enabled?: boolean;
    readonly threshold?: number;
  };
  /** (P2, I-P2-2/3) 信念支柱：启用后构造自然梯度信念 / 粒子滤波信念引擎，任务末经 SparkController 对"自体"行为向量做可审计 KL 分解更新（信息几何）。缺省关，零破坏。 */
  readonly belief?: {
    readonly enabled?: boolean;
    /** 启用算法：自然梯度 / 粒子滤波 / 二者（默认 both）。 */
    readonly algorithm?: 'natural-gradient' | 'particle-filter' | 'both';
    /** 信念维度（默认 3）。 */
    readonly dim?: number;
    /** 初始方差（默认 1）。 */
    readonly initialVariance?: number;
    /** 粒子滤波粒子数（默认 200）。 */
    readonly particles?: number;
    /** 观测噪声（correct 似然尺度，默认 1）。 */
    readonly observationNoise?: number;
  };
  /** 初始技能池（可选）：受种进内置 SkillRegistry，供 CRISPR 编辑与相变固化复用。缺省空池。 */
  readonly skills?: readonly Skill[];
  /** (P2, I-P2-4) CRISPR 精确技能编辑：启用后构造 CRISPRSkillEditor（接 SkillPort），对技能做定点 patch + 差异测试回滚（fail-closed）。缺省关，零破坏。 */
  readonly skillEditing?: {
    readonly enabled?: boolean;
    /** 语义寻址共振阈值（默认 0.5）。 */
    readonly addressThreshold?: number;
    /** 能力场维度（默认 257）。 */
    readonly bins?: number;
  };
  /** (P2, I-P2-5) 相变固化：启用后构造 CapabilityCrystallizer，对常用技能组合按经验密度越阈冻结为原生能力（加法式、fail-closed）。缺省关，零破坏。 */
  readonly capabilityCrystallization?: {
    readonly enabled?: boolean;
    /** 临界阈值（默认 3）。 */
    readonly densityThreshold?: number;
    /** 观测指数衰减（默认 1 = 简单累计）。 */
    readonly decay?: number;
    /** 莫尔组合能力场边长（默认 32）。 */
    readonly fieldSize?: number;
    /** 越阈后密度归零（默认 true）。 */
    readonly resetOnCrystallize?: boolean;
  };
  /** (P3, I-P3-1) 刻蚀记忆：启用后构造 InsightEtchingEngine，顿悟事件在记忆介质上刻出分形分支树、后续沿刻痕低阻导通。缺省关，零破坏。 */
  readonly insightEtching?: {
    readonly enabled?: boolean;
    /** 共振阈值（conduct 命中下限，默认 0.4）。 */
    readonly resonanceThreshold?: number;
  };
  /** (P3, I-P3-2) 元素组合基元：启用后构造 ElementComposer（有限基元周期表），组合合法 = 价互补。缺省关，零破坏。 */
  readonly elementComposer?: {
    readonly enabled?: boolean;
  };
  /** (P3, I-P3-3) 对称破缺算子：启用后构造 SymmetryBreakingEngine，以经验密度为序参量 ρ 观测能力相变。缺省关，零破坏。 */
  readonly symmetryBreaking?: {
    readonly enabled?: boolean;
    /** 破缺阈值（ρ 越此值即破缺，默认 0.6）。 */
    readonly threshold?: number;
  };
  /** (P3, I-P3-4) 禁闭色荷端口：启用后构造 ConfinementEngine，裸能力结构性拒配、仅颜色单态可暴露。缺省关，零破坏。 */
  readonly confinement?: {
    readonly enabled?: boolean;
    /** 群阶（默认 3，对应 SU(3) 三色）。 */
    readonly groupOrder?: number;
  };
  /** (P4, I-P4-3) 长期运行遥测端口：配置后 SparkController 每轮 cycle 落盘一条 production 观测，供后续参数收紧回填。缺省不采集，零破坏。 */
  readonly runtimeTelemetry?: RuntimeTelemetryPort;
  /**
   * Genesis 自适应编排（研究 #18/#19 落地）：启用后 SparkController 的发射顺序由
   * `planHarnessRegime(regime)` 按工况纯函数决定，且每笔成本进入守恒账本。
   * 缺省关，零回归；桥异常时自动回落既有 legacy 发射路径（fail-closed）。
   */
  readonly genesis?: {
    readonly enabled?: boolean;
    /** 工况信号（熵/模态数/成本压力/成功率）；缺省低熵基线。 */
    readonly signals?: RegimeSignals;
  };
}

/** 额外自定义工具（定制接入专用插口）。 */
export interface ExtraTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

/** 解析后的配置：全部端口已填默认实现（ConfigFactory.build 的返回类型）。 */
export interface ResolvedConfig extends OmniHarnessConfig {
  readonly approvals: ApprovalPort;
  readonly sandbox: SandboxPort;
  readonly events: EventPort;
  readonly tools: ToolPort;
  readonly spill: SpillPort;
  readonly spiller: ToolResultSpiller;
  readonly planMode: boolean;
  readonly userResponder: UserResponder;
  readonly todo: TodoPort;
  readonly plan: PlanPort;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，使延迟加载工具后续回合对模型可见。 */
  readonly discovery: ToolDiscovery;
  /** 检索端口（#M2）：会话历史事件索引供 memory_search 检索，实现跨长对话 recall。 */
  readonly retrieval: RetrievalPort;
  /** 升级审批端口（#G3/G4）：沙箱拒绝时咨询，决定是否提权重试（fail-closed 默认不提权）。 */
  readonly escalation: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，默认 policy=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦。 */
  readonly elevatedSandbox: SandboxPort;
  /** 回合级变更追踪器（#M5）：关闭时为 undefined，不追踪也不产事件。与 `OmniHarnessConfig.turnDiff`（布尔开关）区分命名，避免类型冲突。 */
  readonly turnDiffTracker?: TurnDiffTracker;
  /** 工具钩子运行器（#M5）：变更追踪钩子注册于此；无追踪需求时为 undefined。 */
  readonly hooks?: ToolHookRunner;
  /** 长期记忆端口（#S28）：跨会话持久 fact 存储，默认文件落盘；recall 工具与回合末蒸馏共用。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** 长期记忆蒸馏器（#S28，可选）：模型存在且未关 memoryConsolidate 时构造，回合末自动沉淀；否则 undefined（仅支持显式 remember）。 */
  readonly memoryExtractor?: MemoryExtractor;
  /** 成本预算计量（#S29，可选）：配置 costBudgetUsd 正数时构造，BudgetedModel 与 budget_status 工具共享同一实例（含子代）。 */
  readonly costBudget?: CostBudget;
  /** 自主目标循环最大迭代次数（#S30，默认 10，CLI/工具可覆盖）。 */
  readonly goalMaxIterations: number;
  /** LSP 代码导航端口（#S32，可选）：配置了 lsp 服务器时构造 LspProcessAdapter，否则 undefined（LSP 工具不注册）。 */
  readonly lsp?: LspPort;
  /** Agent 密码学身份端口（#S33，可选）：配置了 agentIdentity 时构造 Ed25519AgentIdentity，否则 undefined（agent_identity 工具不注册）。 */
  readonly identity?: AgentIdentityPort;
  /** 工具输入实时观察端口（#B3，可选）：模型流式生成的工具参数增量经此推给 UI；createRuntime 默认 ConsoleLiveView。 */
  readonly live?: ToolInputSink;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省不启用，零破坏。 */
  readonly evolution?: EvolutionController;
  /** 燧内核控制器（S+，可选）：任一燧能力启用时构造，Agent 任务完成后可在 fail-closed 下跑 燧-3/燧-4 调谐/冲刷/(D) 退火/(E) 宇宙网/QEC/免疫；缺省不启用，零破坏。 */
  readonly spark?: SparkController;
  /** (D) 热方程记忆退火器（memoryAnnealing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly annealer?: MemoryAnnealer;
  /** (E, I-P1-2) 宇宙网记忆引擎（memoryWeb.enabled 时构造并注入 spark；U1 默认开时即 ResonantField 单一状态源，实现 CosmicWebPort）；缺省 undefined，零破坏。 */
  readonly web?: CosmicWebPort;
  /** (E, I-P1-3) QEC 记忆编码器（qec.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly qecEncoder?: QECEncoder;
  /** (E, I-P1-5) 免疫异常监控器（immuneMonitoring.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly immune?: ImmuneMonitor;
  /** (P2, I-P2-2) 自然梯度信念引擎（belief 启用且 algorithm 含 natural-gradient 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly naturalGradient?: NaturalGradientBelief;
  /** (P2, I-P2-3) 粒子滤波信念引擎（belief 启用且 algorithm 含 particle-filter 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly particleFilter?: ParticleFilterBelief;
  /** (P2, I-P2-4/5) 受种技能注册表：CRISPR 编辑面 / 相变固化组合解析面；同时可注入 Agent 增强技能匹配。 */
  readonly skillRegistry: SkillRegistry;
  /** (P2, I-P2-4) CRISPR 精确技能编辑器（skillEditing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crispr?: CRISPRSkillEditor;
  /** (P2, I-P2-5) 相变固化器（capabilityCrystallization.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crystallizer?: CapabilityCrystallizer;
  /** (P3, I-P3-1) 刻蚀记忆引擎（insightEtching.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly etching?: InsightEtchingEngine;
  /** (P3, I-P3-2) 元素组合基元引擎（elementComposer.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly elementComposerEngine?: ElementComposer;
  /** (P3, I-P3-3) 对称破缺引擎（symmetryBreaking.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly symmetry?: SymmetryBreakingEngine;
  /** (P3, I-P3-4) 禁闭色荷引擎（confinement.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly confinementEngine?: ConfinementEngine;
}

/** 子智能体端口种子（缺 tools，待注册表构造完成后回填）。 */
export type SubagentPortSeed = Omit<SubagentPorts, 'tools'> & {
  readonly subagent: SubagentOptions;
  /** 自主目标循环默认最大迭代次数（#S30，供 run_goal 工具读取）。 */
  readonly goalMaxIterations: number;
};

/**
 * 配置装配器（组合根）：填默认端口，未注入的用内置实现。
 *
 * 只做**编排**，不亲自装配具体端口——四类领域装配函数各司其职（同目录顶层函数范式，与
 * `configToolRegistry.ts` 一致）：
 * `assembleCorePorts`（基础设施）、`assembleMemoryStack`（长期记忆栈 + 知识算子）、
 * `assembleSkillStack`（技能 / 能力算子栈）、`assembleSpark`（燧内核）。
 * 本类负责确定装配顺序（记忆封包必须先于蒸馏器 / 燧内核，保证单一状态源）、
 * 构造成本预算与模型，并把各切片拼成 `ResolvedConfig`。
 */
export class ConfigFactory {
  /**
   * 构造完整配置。
   * @param partial 未解析的运行配置（用户注入优先，缺省落内置实现）。
   * @returns 全部端口已填默认实现的 `ResolvedConfig`。
   */
  public static build(partial: OmniHarnessConfig): ResolvedConfig {
    const core = assembleCorePorts(partial);
    const costBudget = buildCostBudget(partial);
    const model = buildModel(partial, costBudget);
    const memory = assembleMemoryStack(partial, model);
    const skills = assembleSkillStack(partial);
    const goalMaxIterations = partial.goalMaxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS;
    // #S32 LSP 代码导航：配置了服务器命令才构造进程级适配器；否则 undefined（LSP 工具不注册，主循环零侵入）。
    const lsp = buildLsp(partial);
    // #S33 Agent 密码学身份：配置了私钥/runtimeId 才构造 Ed25519 身份；否则 undefined（agent_identity 工具不注册）。
    const identity = buildIdentity(partial);
    const seed = seedOf(
      partial,
      core.ports.approvals,
      core.ports.sandbox,
      core.ports.events,
      core.ports.spill,
      core.ports.spiller,
      core.ports.escalation,
      core.ports.elevatedSandbox,
      memory.stack.longTermMemory,
      costBudget,
    );
    const spark = assembleSpark(partial, { vortex: core.vortex, memory, skills });
    return {
      workspaceRoot: partial.workspaceRoot,
      maxSteps: partial.maxSteps,
      turnTokenBudget: partial.turnTokenBudget,
      reasoning: partial.reasoning,
      model,
      storage: partial.storage,
      compactionMaxTokens: partial.compactionMaxTokens,
      compactionKeepRecent: partial.compactionKeepRecent,
      fragments: partial.fragments,
      native: partial.native,
      live: partial.live,
      evolution: partial.evolution,
      runtimeTelemetry: partial.runtimeTelemetry,
      costBudget,
      goalMaxIterations,
      lsp,
      identity,
      spark,
      tools:
        partial.tools ??
        defaultTools(
          seed,
          partial.extraTools,
          partial.workers,
          {
            todo: core.ports.todo,
            plan: core.ports.plan,
            userResponder: core.ports.userResponder,
            planMode: core.ports.planMode,
          },
          core.ports.discovery,
          core.ports.retrieval,
          partial.deferredTools,
          memory.stack.longTermMemory,
          costBudget,
          lsp,
          identity,
        ),
      ...core.ports,
      ...memory.stack,
      ...skills,
    };
  }
}

/**
 * 成本预算（#S29）：设正数硬预算时构造单例，`BudgetedModel` 与 `budget_status` 工具共享
 * （含子代同一实例）。非正数 / 未设置即关闭。
 *
 * @param partial 未解析的运行配置。
 * @returns 硬预算计量器，未启用时为 undefined。
 */
function buildCostBudget(partial: OmniHarnessConfig): CostBudget | undefined {
  if (partial.costBudgetUsd === undefined || partial.costBudgetUsd <= 0) {
    return undefined;
  }
  return new CostBudget(
    partial.costBudgetUsd,
    mergeRoutePricing(partial.routePricing),
    DEFAULT_FALLBACK_PRICE,
    undefined,
    partial.costBudgetOnExceed !== 'warn',
  );
}

