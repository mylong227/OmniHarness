import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { SsrfPolicyConfig } from './configFile.js';
import type { ToolInputSink } from '../ports/tool/toolInputSink.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { ModelPort, RoutePrice } from '../ports/model/model.js';
import { CostBudget, DEFAULT_SOFT_RATIO } from '../adapters/model/costBudget.js';
import { CostBudgetDegradeAdapter } from '../adapters/model/costBudgetDegradeAdapter.js';
import {
  EnforcementModeResolver,
  type EnforcementMode,
} from '../security/enforcementModeResolver.js';
import { RoutePricing, DEFAULT_FALLBACK_PRICE } from '../adapters/model/routePricing.js';
import type { BudgetDegradeSignal } from '../ports/model/budgetDegrade.js';
import { log } from '../util/logger.js';
import { ConsoleLiveView } from '../adapters/live/consoleLiveView.js';
import { CompositeLiveView } from '../adapters/live/compositeLiveView.js';
import { TransformersEmbeddingAdapter } from '../adapters/embedding/transformersEmbeddingAdapter.js';

import type { ModelRouterConfig } from './configFile.js';
import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { EmbeddingPort } from '../ports/model/embedding.js';
import type { StoragePort } from '../ports/memory/storage.js';
import type { RetrievalPort } from '../ports/intelligence/retrieval.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';
import type { SpillPort } from '../ports/memory/spill.js';
import type { ToolDefinition, ToolPort } from '../ports/tool/tool.js';
import type { ToolHandler } from '../adapters/tool/toolHandler.js';
import type { TurnDiffTracker } from '../core/turnDiffTracker.js';
import type { ToolHookRunner } from '../core/toolHookRunner.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import type { MemoryExtractorPort } from '../ports/memory/memoryExtractor.js';
import type { CosmicWebPort } from '../ports/memory/cosmicWeb.js';
import type { MemoryAnnealer } from '../ports/memory/memoryAnnealing.js';
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
import type { RuntimeTelemetryPort } from '../ports/runtime/runtimeTelemetry.js';
import type { Skill } from '../skill/skill.js';
import type { SparkController } from '../spark/sparkController.js';
import type { ToolDiscovery } from '../search/toolDiscovery.js';
import type { WorkerRegistry } from '../worker/workerRegistry.js';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../autonomy/goalRunner.js';

import type { LspPort, LspServerConfig } from '../ports/tool/lsp.js';
import type { AgentIdentityConfig, AgentIdentityPort } from '../ports/runtime/agentIdentity.js';
import type { SubagentPortsShape } from '../subagent/subagentPorts.js';
import type { SubagentOptions } from '../subagent/subagentTypes.js';
import type { UserResponder } from '../ports/runtime/userResponder.js';
import type { TodoPort } from '../ports/runtime/todo.js';
import type { PlanPort } from '../ports/runtime/plan.js';
import type { EvolutionController } from '../ports/runtime/evolution.js';
import type { RegimeSignals } from '../genesis/operators.js';

import { ConfigBuilder } from './configBuilder.js';
import { ConfigToolRegistry } from './configToolRegistry.js';
import { SelfVerifyPolicy } from '../adapters/tool/verify/selfVerifyPolicy.js';
import { CorePortsAssembler } from './corePortsAssembler.js';
import { MemoryStackAssembler } from './memoryStackAssembler.js';
import { RepoMapContextEngine } from '../context/repoMapContextEngine.js';
import type { ScratchpadPort } from '../ports/memory/scratchpad.js';
import { SkillStackAssembler } from './skillStackAssembler.js';
import { SparkAssembler } from './sparkAssembler.js';

/** OmniHarness运行时配置：端口注入即插即用，核心零依赖具体实现。 */
/**
 * （P3）自验证回环配置：写源码后自动跑受限测试并回灌失败摘要。
 *
 * 默认全部保守：超时 120s、输出上限 256 KiB、冷却 60s、每会话最多 3 次、摘要 15 行。
 * `enabled === true` 后取命令的优先级：**显式 `command` 直接生效**（不受「仓库有测试症状」闸门约束）；
 * 未给 `command` 时由 `SelfVerifyCommandDetector` 从仓库证据推断（npm / pytest / cargo / go /
 * maven / gradle / rspec / dotnet / make）；两者皆无则不启用（fail-closed）。
 */
export interface SelfVerifyConfig {
  /** 是否启用（默认 false）。 */
  readonly enabled: boolean;
  /** 测试命令（缺省 `npm test`）。 */
  readonly command?: string | undefined;
  /** 同一会话两次自验证的最小间隔（毫秒，默认 60000）。 */
  readonly cooldownMs?: number | undefined;
  /** 同一会话最多触发次数（默认 3）。 */
  readonly maxRunsPerSession?: number | undefined;
  /** 单次测试命令超时（毫秒，默认 120000）。 */
  readonly timeoutMs?: number | undefined;
  /** 单路输出缓冲上限（字节，默认 262144）。 */
  readonly maxOutputBytes?: number | undefined;
  /** 回灌摘要行数上限（默认 15）。 */
  readonly maxDigestLines?: number | undefined;
}

export interface OmniHarnessConfig {
  readonly workspaceRoot: string;
  readonly maxSteps: number;
  /** 回合 token 预算（V2.1 / B4，可选）：累计模型 usage 超限即停止步进交由总结收尾。0/缺省关闭。 */
  readonly turnTokenBudget?: number | undefined;
  readonly model: ModelPort;
  readonly storage: StoragePort;
  readonly approvals?: ApprovalPort | undefined;
  /**
   * 推理强度（#B6，可选）：none / minimal / low / medium / high / xhigh / max，透传为模型 reasoning_effort。
   *
   * 7 档与配置文件校验器 `ENUM_VALUES.reasoning`、厂商预设清单一致（原 5 档类型与之不符，见 `configFile.ts` 同名字段）。
   */
  readonly reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  readonly sandbox?: SandboxPort | undefined;
  readonly events?: EventPort | undefined;
  readonly tools?: ToolPort | undefined;
  readonly extraTools?: readonly ExtraTool[] | undefined;
  readonly compactionMaxTokens?: number | undefined;
  readonly compactionKeepRecent?: number | undefined;
  /**
   * 发往模型前的**确定性无损收缩**（P2 打磨，默认 true）。
   * 只裁行尾空白 / 3+ 连续空行 / 整段 JSON 缩进，不删字符级事实；关闭后逐字节回到旧行为。
   */
  readonly compactionDeterministicShrink?: boolean | undefined;
  /** 自定义外溢端口（不传用内置实现）。 */
  readonly spill?: SpillPort | undefined;
  /** 内置外溢后端：file（落盘，跨重启可恢复，默认）| memory（进程内）。 */
  readonly spillAdapter?: 'memory' | 'file' | undefined;
  /** 文件外溢目录（相对 workspaceRoot，默认 .omniharness/spill）。 */
  readonly spillDir?: string | undefined;
  /** 输出超过此字节数触发外溢（默认 16384）。 */
  readonly spillMaxInlineBytes?: number | undefined;
  /** 外溢后保留的预览字节数（默认 2048）。 */
  readonly spillPreviewBytes?: number | undefined;
  /**
   * 文件外溢**产物保留上限**（个，默认 512；`0` = 不回收）。
   *
   * 审计 §1.7「spill 产物无回收」的收口：此前 `.omniharness/spill` 只写不删、无界增长。
   * 超限按 mtime 删最旧（`spill_read` 的现实用法是同回合回读，最旧的先淘汰）。
   */
  readonly spillMaxFiles?: number | undefined;
  /**
   * 燧-4 涡环包**进程内保留上限**（个，默认 256；`0` = 不淘汰）。
   *
   * 审计 §1.7「涡环包无回收」的收口：`rings` 表此前只增不减 ⇒ 长跑会话内存单调增长。
   * 超限按 LRU 淘汰（`read` 命中即续命）。
   */
  readonly spillMaxRings?: number | undefined;
  readonly workers?: WorkerRegistry | undefined;
  /** 子智能体最大派生深度（默认 2：允许 1 层子智能体，depth >= 该值即拒绝）。 */
  readonly subagentMaxDepth?: number | undefined;
  /** 子智能体并发上限（默认 4）。 */
  readonly subagentConcurrency?: number | undefined;
  /** 单个子智能体的步数上限（默认 12）。 */
  readonly subagentMaxSteps?: number | undefined;
  readonly fragments?: readonly string[] | undefined;
  /** 启用 FFI 原生后端（#66）：工具执行路由到 Rust 内核 in-process；内核不可用时静默回退 TS。 */
  readonly native?: boolean | undefined;
  /** 计划模式（#77）：开启后未批准计划前，ToolGate 拦截所有写类工具（探索/提问/计划类可用）。 */
  readonly planMode?: boolean | undefined;
  /** 自定义用户回答端口（不传按 TTY 自动选 Console/Default）。 */
  readonly userResponder?: UserResponder | undefined;
  /** 自定义待办端口（不传用内存实现）。 */
  readonly todo?: TodoPort | undefined;
  /** 自定义计划端口（不传用内存实现）。 */
  readonly plan?: PlanPort | undefined;
  /** 延迟加载工具名清单（#M1）：列出的工具默认不注入模型上下文，需经 tool_search 发现后可见（省上下文）。 */
  readonly deferredTools?: readonly string[] | undefined;
  /** 自定义检索端口（#M2，缺省用内存 BM25）。会话历史事件经记录器索引后供 memory_search 检索。 */
  readonly retrieval?: RetrievalPort | undefined;
  /** 升级审批端口（#G3/G4，缺省 DenyEscalation=fail-closed 不提权）。沙箱拒绝时咨询，决定是否提权重试。 */
  readonly escalation?: EscalationPort | undefined;
  /** 提权后的复核沙箱（缺省 PolicySandbox=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦。 */
  readonly elevatedSandbox?: SandboxPort | undefined;
  /** 审批缓存（#M4，默认关）：开启后同一「工具 + 规范化命令 + cwd + 策略指纹」只问一次。 */
  readonly approvalCache?: boolean | undefined;
  /** 审批缓存上限（#M4，默认 256）：超出按 LRU 淘汰。 */
  readonly approvalCacheMaxEntries?: number | undefined;
  /** 智能模型路由（#B4，可选）：配置后以 ModelRouter 替换默认 model 适配器，按策略在 entries 间路由（fail-closed）。 */
  readonly modelRouter?: ModelRouterConfig | undefined;
  /** 模型调用重试（#M6，默认关）：开启后对 429/5xx/网络抖动按指数退避自动重试。 */
  readonly modelRetry?: boolean | undefined;
  /** 模型重试最大次数（#M6，默认 3，含首次）。 */
  readonly modelRetryMaxAttempts?: number | undefined;
  /** 模型重试基础退避毫秒（#M6，默认 500）。 */
  readonly modelRetryBaseDelayMs?: number | undefined;
  /** 模型调用熔断开关（F3，默认开）：下游连续失败达阈值即开路，冷却期快速失败、冷却后半开探测。 */
  readonly modelCircuitBreaker?: boolean | undefined;
  /** 熔断开路阈值（连续失败次数，默认 5）。 */
  readonly modelCircuitBreakerThreshold?: number | undefined;
  /** 熔断开路冷却毫秒（默认 30000）。 */
  readonly modelCircuitBreakerOpenMs?: number | undefined;
  /** Agent 密码学身份配置（#S33，可选）：声明 Ed25519 私钥（PKCS#8 der base64）与 runtime id；不配则每次运行生成临时身份、且不注册 `agent_identity` 工具。零依赖（仅 Node 内置 node:crypto）。 */
  readonly agentIdentity?: AgentIdentityConfig | undefined;
  /** 回合级变更追踪（#M5，默认开）：写类工具前后取样，回合结束广播 unified diff 事件。 */
  readonly turnDiff?: boolean | undefined;
  /** 长期记忆（#S28，默认开）：跨会话持久 fact 存储，落盘于 <workspace>/.omniharness/longterm/memory.jsonl；注入自定义实现则覆盖默认文件存储。 */
  readonly longTermMemory?: LongTermMemoryPort | undefined;
  /** 长期记忆落盘路径（#S28，默认 <workspace>/.omniharness/longterm/memory.jsonl）。 */
  readonly longTermMemoryPath?: string | undefined;
  /** 回合末自动蒸馏沉淀（#S28，默认开）：每回合末用模型把对话蒸馏为持久事实；关掉则仅支持模型显式 remember。 */
  readonly memoryConsolidate?: boolean | undefined;
  /** 每回合蒸馏最多沉淀事实数（#S28，默认 8）。 */
  readonly memoryConsolidateMaxFacts?: number | undefined;
  /** 长期记忆落盘加密（#4.4 Vault 集成，默认关）：开启后用 AES-256-GCM 逐行加密 memory.jsonl。 */
  readonly longTermMemoryEncryption?: boolean | undefined;
  /** 加密密钥文件路径（#4.4）：缺省为 <workspace>/.omniharness/longterm/memory.key，首次使用自动生成。 */
  readonly longTermMemoryKeyFile?: string | undefined;
  /** 成本硬预算（#S29，USD）：设正数后按路由定价累计模型花费，越上限即熔断（fail-closed 阻断后续调用）。0 / 不设为关闭。 */
  readonly costBudgetUsd?: number | undefined;
  /** 自定义路由定价表（#S29，USD / 百万 token）：键为模型名（精确或前缀匹配），叠在默认表之上。 */
  readonly routePricing?: Record<string, RoutePrice> | undefined;
  /** 预算耗尽行为（#S29，默认 'fail'）：'fail' 抛错阻断；'warn' 仅回调不阻断（软预算，仅观测）。 */
  readonly costBudgetOnExceed?: 'fail' | 'warn' | undefined;
  /** 软阈值比例（P5，相对硬预算，默认 {@link DEFAULT_SOFT_RATIO}）：达该比例即置位「建议降级」信号。 */
  readonly costBudgetSoftRatio?: number | undefined;
  /** 自主目标循环最大迭代次数（#S30，默认 10）：run_goal 工具与 CLI goal 子命令的默认上限。 */
  readonly goalMaxIterations?: number | undefined;
  /** LSP 代码导航服务器配置（#S32，可选）：声明如何启动外部语言服务器；不配则 LSP 工具不注册。零依赖——服务器由用户自备（如 typescript-language-server）。运行时端口见 `ResolvedConfig.lsp`。 */
  readonly lspServer?: LspServerConfig | undefined;
  /** 工具输入实时观察端口（#B3，可选）：注入自定义实时视图（TUI / web）以渐进渲染工具参数；不配则由 createRuntime 默认 ConsoleLiveView（TTY 实时刷新）。 */
  readonly live?: ToolInputSink | undefined;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省不启用，零破坏。 */
  readonly evolution?: EvolutionController | undefined;
  /**
   * (U4 升格) RLVR 进化闭环：启用时运行时自动构造「可验证门禁 + RLVR sample-filter-replay」控制器，
   * 取代/补充 `evolution` 注入。每个过门禁的候选再跑一轮 StarPO 采样→可验证奖励（编译/测试绿度）打分→
   * 绿样本进回放缓冲，仅「绿」样本才晋升。缺省关，零破坏。
   */
  readonly evolutionRlvr?:
    | {
        readonly enabled?: boolean | undefined;
        /** 发现预算上限（默认 12）。 */
        readonly maxCandidates?: number | undefined;
        /** 每 prompt 采样数（默认 8）。 */
        readonly samplesPerPrompt?: number | undefined;
        /** RLVR 最低保留阈值（默认 0）。 */
        readonly minReward?: number | undefined;
        /** 候选代码验证命令（含 `%CODE_FILE%` 占位符）。缺省则 RLVR 奖励恒 0（无样本进回放，安全旁路）。 */
        readonly verifyCommand?: string | undefined;
        /** 验证临时文件扩展名（默认 `.ts`）。`node --check` 验证 JS 代码须传 `.js`（Node 22.18 起才默认解析 `.ts`）。 */
        readonly verifyCodeFileExtension?: string | undefined;
        /** 门禁基准增益阈值（默认 0.05）。 */
        readonly minGain?: number | undefined;
        /** 任务完成后自动进化（默认 false）。 */
        readonly autoRun?: boolean | undefined;
      }
    | undefined;
  /** 提示注入护栏（opt-in，默认关）：开启后工具结果进模型上下文前做确定性指令注入扫描，命中即隔离（不喂给模型）。零依赖、纯规则启发式、失败开放（扫描器异常时放行原始结果）。 */
  readonly promptInjectionGuard?: boolean | EnforcementMode | undefined;
  /**
   * （P3）自验证回环（opt-in，默认关）：开启后**写类工具改写源码**时自动跑受限测试命令，
   * 把失败摘要回灌到该次工具结果（模型同一步即知「改坏了」），并复用 `SelfChecklist` 做假完成探测。
   *
   * 生效还须**仓库有测试症状**（`package.json` 含 `scripts.test`），否则静默不启用。
   * 纪律：不进主门禁、可关、有超时与预算上限（见各字段默认值）。
   */
  readonly selfVerify?: SelfVerifyConfig | undefined;
  /** 燧-4 涡环包（S+ 发明层）：启用后工具大输出外溢封成拓扑环包（fail-closed 抗污染、不随内容膨胀）。缺省关，零破坏。 */
  readonly vortexRing?: { enabled: boolean } | undefined;
  /** 燧内核 autoRun（复用 I-P1-4 进化闭环的 autoRun 钩子）：任务完成后跑一轮 燧-3/燧-4 调谐/冲刷/(D) 退火。缺省关，零破坏。 */
  readonly sparkAutoRun?: boolean | undefined;
  /** (D) 热方程记忆重加权 / 退火调度（S+ 知识基础算子）：启用后对长期记忆跑频率域共振耦合的热方程扩散 + 温度退火，使共振簇共识、孤立事实自然遗忘。缺省关，零破坏。 */
  readonly memoryAnnealing?:
    | {
        readonly enabled?: boolean | undefined;
        readonly coupling?: number | undefined;
        readonly initialTemperature?: number | undefined;
        readonly coolingRate?: number | undefined;
        readonly decay?: number | undefined;
        readonly resonanceThreshold?: number | undefined;
        readonly maxFacts?: number | undefined;
      }
    | undefined;
  /**
   * (U1) 共振场统一基板：长期记忆走单一 ResonantField 引擎（合并 燧-3 共振寻址 + 宇宙网，
   * 消除双重频谱索引）。**默认开启**；显式 `enabled: false` 才关（关闭 = 裸长期记忆，无共振/宇宙网能力）。
   * 原分别启用的 `resonance` / `memoryWeb` 配置块已随 0.3.0 移除（与 U1 同算法重复，见弃用公告）。
   */
  readonly resonantField?:
    | {
        readonly enabled?: boolean | undefined;
        readonly adhesionThreshold?: number | undefined;
        readonly bekensteinCap?: number | undefined;
      }
    | undefined;
  /** (U6) A2A 互操作：启用后运行时起 A2aServer（监听端口）并构造 A2aClient，server 任务处理器跑子 agent 完成对等委托（能力胶囊 Ed25519 签名即身份，fail-closed 验签）。缺省关，零破坏。 */
  readonly a2a?:
    | {
        readonly enabled?: boolean | undefined;
        /** 服务端监听端口（默认 8790，避开 appServer 8787）。 */
        readonly port?: number | undefined;
        /** 本端 client 默认对端端点（委托目标，缺省按 transport 派生：http://…/a2a 或 ws://…/a2a-ws）。 */
        readonly peerEndpoint?: string | undefined;
        /** 传输形态（默认 http）：http = POST /a2a，ws = RFC6455 长连接 /a2a-ws。 */
        readonly transport?: 'http' | 'ws' | undefined;
      }
    | undefined;
  /** (E, I-P1-3) QEC 记忆编码器：启用后对长期记忆跑二维奇偶症状编码 + 全量校验，单点 corrupt 自动定位纠正（fail-closed 不静默接受多点损坏）。缺省关，零破坏。 */
  readonly qec?:
    | {
        readonly enabled?: boolean | undefined;
        readonly cols?: number | undefined;
      }
    | undefined;
  /** (E, I-P1-5) 免疫异常监控：启用后训练自体检测器，对记忆健康度等"自体"行为向量周期采样，偏离即告警/隔离（fail-closed，不擅自改写）。缺省关，零破坏。 */
  readonly immuneMonitoring?:
    | {
        readonly enabled?: boolean | undefined;
        readonly threshold?: number | undefined;
      }
    | undefined;
  /** (P2, I-P2-2/3) 信念支柱：启用后构造自然梯度信念 / 粒子滤波信念引擎，任务末经 SparkController 对"自体"行为向量做可审计 KL 分解更新（信息几何）。缺省关，零破坏。 */
  readonly belief?:
    | {
        readonly enabled?: boolean | undefined;
        /** 启用算法：自然梯度 / 粒子滤波 / 二者（默认 both）。 */
        readonly algorithm?: 'natural-gradient' | 'particle-filter' | 'both' | undefined;
        /** 信念维度（默认 3）。 */
        readonly dim?: number | undefined;
        /** 初始方差（默认 1）。 */
        readonly initialVariance?: number | undefined;
        /** 粒子滤波粒子数（默认 200）。 */
        readonly particles?: number | undefined;
        /** 观测噪声（correct 似然尺度，默认 1）。 */
        readonly observationNoise?: number | undefined;
      }
    | undefined;
  /** 初始技能池（可选）：受种进内置 SkillRegistry，供 CRISPR 编辑与相变固化复用。缺省空池。 */
  readonly skills?: readonly Skill[] | undefined;
  /**
   * SSRF / 出站策略表（2026-09-22 配置化）：元数据主机 / 内网域名后缀 / IPv4 网段。
   * 缺省用内置默认档（与历史行为逐字一致）；消费方用 `security/ssrfPolicy.resolveSsrfPolicy` 解析。
   */
  readonly ssrfPolicy?: SsrfPolicyConfig | undefined;
  /** (P2, I-P2-4) CRISPR 精确技能编辑：启用后构造 CRISPRSkillEditor（接 SkillPort），对技能做定点 patch + 差异测试回滚（fail-closed）。缺省关，零破坏。 */
  readonly skillEditing?:
    | {
        readonly enabled?: boolean | undefined;
        /** 语义寻址共振阈值（默认 0.5）。 */
        readonly addressThreshold?: number | undefined;
        /** 能力场维度（默认 257）。 */
        readonly bins?: number | undefined;
      }
    | undefined;
  /** (P2, I-P2-5) 相变固化：启用后构造 CapabilityCrystallizer，对常用技能组合按经验密度越阈冻结为原生能力（加法式、fail-closed）。缺省关，零破坏。 */
  readonly capabilityCrystallization?:
    | {
        readonly enabled?: boolean | undefined;
        /** 临界阈值（默认 3）。 */
        readonly densityThreshold?: number | undefined;
        /** 观测指数衰减（默认 1 = 简单累计）。 */
        readonly decay?: number | undefined;
        /** 莫尔组合能力场边长（默认 32）。 */
        readonly fieldSize?: number | undefined;
        /** 越阈后密度归零（默认 true）。 */
        readonly resetOnCrystallize?: boolean | undefined;
      }
    | undefined;
  /** (P3, I-P3-1) 刻蚀记忆：启用后构造 InsightEtchingEngine，顿悟事件在记忆介质上刻出分形分支树、后续沿刻痕低阻导通。缺省关，零破坏。 */
  readonly insightEtching?:
    | {
        readonly enabled?: boolean | undefined;
        /** 共振阈值（conduct 命中下限，默认 0.4）。 */
        readonly resonanceThreshold?: number | undefined;
      }
    | undefined;
  /** (P3, I-P3-2) 元素组合基元：启用后构造 ElementComposer（有限基元周期表），组合合法 = 价互补。缺省关，零破坏。 */
  readonly elementComposer?:
    | {
        readonly enabled?: boolean | undefined;
      }
    | undefined;
  /** (P3, I-P3-3) 对称破缺算子：启用后构造 SymmetryBreakingEngine，以经验密度为序参量 ρ 观测能力相变。缺省关，零破坏。 */
  readonly symmetryBreaking?:
    | {
        readonly enabled?: boolean | undefined;
        /** 破缺阈值（ρ 越此值即破缺，默认 0.6）。 */
        readonly threshold?: number | undefined;
      }
    | undefined;
  /** (P3, I-P3-4) 禁闭色荷端口：启用后构造 ConfinementEngine，裸能力结构性拒配、仅颜色单态可暴露。缺省关，零破坏。 */
  readonly confinement?:
    | {
        readonly enabled?: boolean | undefined;
        /** 群阶（默认 3，对应 SU(3) 三色）。 */
        readonly groupOrder?: number | undefined;
      }
    | undefined;
  /** (P4, I-P4-3) 长期运行遥测端口：配置后 SparkController 每轮 cycle 落盘一条 production 观测，供后续参数收紧回填。缺省不采集，零破坏。 */
  readonly runtimeTelemetry?: RuntimeTelemetryPort | undefined;
  /**
   * Genesis 自适应编排（研究 #18/#19 落地）：启用后 SparkController 的发射顺序由
   * `planHarnessRegime(regime)` 按工况纯函数决定，且每笔成本进入守恒账本。
   * 缺省关，零回归；桥异常时自动回落既有 legacy 发射路径（fail-closed）。
   */
  readonly genesis?:
    | {
        readonly enabled?: boolean | undefined;
        /** 工况信号（熵/模态数/成本压力/成功率）；缺省低熵基线。 */
        readonly signals?: RegimeSignals | undefined;
      }
    | undefined;
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
  readonly turnDiffTracker?: TurnDiffTracker | undefined;
  /** 工具钩子运行器（#M5）：变更追踪钩子注册于此；无追踪需求时为 undefined。 */
  readonly hooks?: ToolHookRunner | undefined;
  /** 长期记忆端口（#S28）：跨会话持久 fact 存储，默认文件落盘；recall 工具与回合末蒸馏共用。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** repo-map 上下文引擎（P2.2 单例收敛）：组合根唯一构造点，注入 StepRunnerDeps。 */
  readonly repoMapContext: RepoMapContextEngine;
  /** 跨重置便签（T3.4）：重置后读回交接物恢复任务。 */
  readonly scratchpad: ScratchpadPort;
  /** 长期记忆蒸馏器（#S28，可选）：模型存在且未关 memoryConsolidate 时构造，回合末自动沉淀；否则 undefined（仅支持显式 remember）。 */
  readonly memoryExtractor?: MemoryExtractorPort | undefined;
  /** 成本预算计量（#S29，可选）：配置 costBudgetUsd 正数时构造，BudgetedModel 与 budget_status 工具共享同一实例（含子代）。 */
  readonly costBudget?: CostBudget | undefined;
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
  readonly qecEncoder?: QECEncoder | undefined;
  /** (E, I-P1-5) 免疫异常监控器（immuneMonitoring.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly immune?: ImmuneMonitor | undefined;
  /** (P2, I-P2-2) 自然梯度信念引擎（belief 启用且 algorithm 含 natural-gradient 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly naturalGradient?: NaturalGradientBelief | undefined;
  /** (P2, I-P2-3) 粒子滤波信念引擎（belief 启用且 algorithm 含 particle-filter 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly particleFilter?: ParticleFilterBelief | undefined;
  /** (P2, I-P2-4/5) 受种技能注册表：CRISPR 编辑面 / 相变固化组合解析面；同时可注入 Agent 增强技能匹配。 */
  readonly skillRegistry: SkillRegistry;
  /** (P2, I-P2-4) CRISPR 精确技能编辑器（skillEditing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crispr?: CRISPRSkillEditor | undefined;
  /** (P2, I-P2-5) 相变固化器（capabilityCrystallization.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crystallizer?: CapabilityCrystallizer | undefined;
  /** (P3, I-P3-1) 刻蚀记忆引擎（insightEtching.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly etching?: InsightEtchingEngine | undefined;
  /** (P3, I-P3-2) 元素组合基元引擎（elementComposer.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly elementComposerEngine?: ElementComposer | undefined;
  /** (P3, I-P3-3) 对称破缺引擎（symmetryBreaking.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly symmetry?: SymmetryBreakingEngine | undefined;
  /** (P3, I-P3-4) 禁闭色荷引擎（confinement.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly confinementEngine?: ConfinementEngine | undefined;
}

/** 子智能体端口种子（缺 tools，待注册表构造完成后回填）。 */
export type SubagentPortSeed = Omit<SubagentPortsShape, 'tools'> & {
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
    const core = CorePortsAssembler.assembleCorePorts(partial);
    const costBudget = ConfigFactory.buildCostBudget(partial);
    // P5 自动降档：把预算计量桥成只读端口，注入 core 消费点（守住 `core → adapters` 红线）。
    // 无预算（costBudgetUsd 未设/非正）时不构造 ⇒ budgetDegrade 恒 undefined，零行为变更。
    const budgetDegrade: BudgetDegradeSignal | undefined =
      costBudget !== undefined ? new CostBudgetDegradeAdapter(costBudget) : undefined;
    const model = ConfigBuilder.buildModel(partial, costBudget);
    const memory = MemoryStackAssembler.assembleMemoryStack(partial, model);
    const skills = SkillStackAssembler.assembleSkillStack(partial);
    const goalMaxIterations = partial.goalMaxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS;
    // #S32 LSP 代码导航：配置了服务器命令才构造进程级适配器；否则 undefined（LSP 工具不注册，主循环零侵入）。
    const lsp = ConfigBuilder.buildLsp(partial);
    // #S33 Agent 密码学身份：配置了私钥/runtimeId 才构造 Ed25519 身份；否则 undefined（agent_identity 工具不注册）。
    const identity = ConfigBuilder.buildIdentity(partial);
    const seed = ConfigBuilder.seedOf(
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
    const spark = SparkAssembler.assembleSpark(partial, { vortex: core.vortex, memory, skills });
    return {
      workspaceRoot: partial.workspaceRoot,
      maxSteps: partial.maxSteps,
      turnTokenBudget: partial.turnTokenBudget,
      reasoning: partial.reasoning,
      model,
      storage: partial.storage,
      compactionMaxTokens: partial.compactionMaxTokens,
      compactionKeepRecent: partial.compactionKeepRecent,
      compactionDeterministicShrink: partial.compactionDeterministicShrink,
      fragments: partial.fragments,
      native: partial.native,
      live: partial.live ?? new CompositeLiveView([new ConsoleLiveView()]),
      // 语义嵌入端口：`OMNI_SEMANTIC_RECALL=1` 才构造（见 buildEmbeddingPort；L5 预热默认关）。
      embedding: ConfigFactory.buildEmbeddingPort(),
      evolution: partial.evolution,
      // (U4) RLVR 进化闭环：此前该字段只在 `OmniHarnessConfig` 上声明、**未被本装配字面量透传**，
      // 导致调用方即便设置 `evolutionRlvr` 也会在此处被静默丢弃，`createRuntime` 恒读不到
      // → 「默认关、端到端未开」的机械根因。此处显式透传；`createRuntime` 在 `enabled===true`
      // 时构造「可验证门禁 + RLVR sample-filter-replay」控制器。
      evolutionRlvr: partial.evolutionRlvr,
      ssrfPolicy: partial.ssrfPolicy, // 配置化 SSRF 策略表（消费方：组合根 A2A / CLI 出站守卫）
      // (P4) 提示注入护栏开关：此前该字段只在 `OmniHarnessConfig` 上**声明**（第 220 行）却**未被本
      // 装配字面量透传**；而 `ResolvedConfig extends OmniHarnessConfig` 且该字段可选 ⇒ TS 不报错、
      // 值被静默丢弃，`agent` 读到的 `config.promptInjectionGuard` 恒为 `undefined`
      // ⇒ `--guard-prompt-injection` 形同虚设、护栏在生产路径上**永不可达**（第九处「声明未接线」，
      // 与 E2 的 a2a / E3 的 evolutionRlvr 同一形态）。此处显式透传；缺省 `undefined` = 默认关（零行为变更）。
      // (D1/D2) 生效模式三态：布尔**原样透传**（`true`=enforce / `false`=off——既有断言与零行为变更均保留）；
      // **字符串必须过白名单校验**：未知取值在此抛错，而不是静默回落成 off——否则「配置写错」会静默
      // 退化成「护栏失效」，与 `src/cli/cliEnums.ts`「安全相关枚举必须显式校验」同一纪律。
      promptInjectionGuard:
        typeof partial.promptInjectionGuard === 'string'
          ? EnforcementModeResolver.modeOf(partial.promptInjectionGuard)
          : partial.promptInjectionGuard,
      runtimeTelemetry: partial.runtimeTelemetry,
      costBudget,
      budgetDegrade,
      goalMaxIterations,
      lsp,
      identity,
      spark,
      // (U6) A2A 互操作：此前该字段只在 `OmniHarnessConfig` 上声明、**未被本装配字面量透传**，
      // 导致 `runtime` 的 `if (config.a2a?.enabled === true)` 恒不可达 —— A2A 生产路径整体不可用
      // （U6 回环实测脚本直接 import a2a 模块、绕过了装配层，故长期未暴露）。此处显式透传。
      a2a: partial.a2a,
      tools:
        partial.tools ??
        ConfigToolRegistry.defaultTools(
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
          ConfigFactory.resolveSelfVerify(partial),
        ),
      ...core.ports,
      ...memory.stack,
      ...skills,
    };
  }

  /**
   * 解析自验证回环策略（P3）。
   *
   * 仅当 `config.selfVerify.enabled === true` 时进一步解析命令：
   * **显式 `selfVerify.command` 直接生效**（不再被「有测试症状」闸门挡住——原实现把显式命令
   * 也一并拦下，属声明未接线）；缺省时由 `SelfVerifyCommandDetector` 从仓库证据推断
   * （npm / pytest / cargo / go / maven / gradle / rspec / dotnet / make）。两者皆无则
   * 返回 `undefined`（不包装装饰器，零行为变更）。
   *
   * @param partial 未解析的运行配置。
   * @returns 自验证策略；未启用、或既无显式命令又探测不到测试症状时为 `undefined`。
   */
  private static resolveSelfVerify(partial: OmniHarnessConfig): SelfVerifyPolicy | undefined {
    const cfg = partial.selfVerify;
    if (cfg === undefined || cfg.enabled !== true || typeof partial.workspaceRoot !== 'string') {
      return undefined;
    }
    return SelfVerifyPolicy.forWorkspace(partial.workspaceRoot, {
      ...(cfg.command !== undefined ? { command: cfg.command } : {}),
      ...(cfg.cooldownMs !== undefined ? { cooldownMs: cfg.cooldownMs } : {}),
      ...(cfg.maxRunsPerSession !== undefined ? { maxRunsPerSession: cfg.maxRunsPerSession } : {}),
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(cfg.maxOutputBytes !== undefined ? { maxOutputBytes: cfg.maxOutputBytes } : {}),
      ...(cfg.maxDigestLines !== undefined ? { maxDigestLines: cfg.maxDigestLines } : {}),
    });
  }
  /**
   * buildCostBudget — module-level helper moved into ConfigFactory.
   * @param {OmniHarnessConfig} partial - partial
   * @returns {CostBudget | undefined} - result
   */
  private static buildCostBudget(partial: OmniHarnessConfig): CostBudget | undefined {
    if (partial.costBudgetUsd === undefined || partial.costBudgetUsd <= 0) {
      return undefined;
    }
    // P5：此前第 4 参（onExceed）恒传 `undefined` ⇒ 越硬预算时只置标记、**无任何上报**，
    // 是个「接线预留但从未接通」的死旋钮。此处接通：硬熔断记 error、软阈值记 warn，
    // 均可被日志管道 / 事件桥观测；降级决策另经 `BudgetSnapshot.degradeSuggested` 暴露。
    return new CostBudget(
      partial.costBudgetUsd,
      RoutePricing.mergeRoutePricing(partial.routePricing),
      DEFAULT_FALLBACK_PRICE,
      (snapshot) => {
        log.error('budget.exceeded', {
          limitUsd: snapshot.limitUsd,
          spentUsd: Number(snapshot.spentUsd.toFixed(6)),
        });
      },
      partial.costBudgetOnExceed !== 'warn',
      partial.costBudgetSoftRatio ?? DEFAULT_SOFT_RATIO,
      (snapshot) => {
        log.warn('budget.softExceeded', {
          limitUsd: snapshot.limitUsd,
          softLimitUsd: Number(snapshot.softLimitUsd.toFixed(6)),
          spentUsd: Number(snapshot.spentUsd.toFixed(6)),
        });
      },
    );
  }

  /**
   * 构造语义嵌入端口（U3 混合检索），并按需触发 L5 预热。
   *
   * @returns 嵌入端口；`OMNI_SEMANTIC_RECALL !== '1'` 时为 `undefined`（纯 BM25、零开销）。
   */
  public static buildEmbeddingPort(): EmbeddingPort | undefined {
    if (process.env.OMNI_SEMANTIC_RECALL !== '1') {
      return undefined;
    }
    const adapter = new TransformersEmbeddingAdapter({
      cacheDir: process.env.OMNI_EMBEDDING_CACHE_DIR,
      localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
      // 模型下载源：`OMNI_HF_ENDPOINT` 优先、回落 `HF_ENDPOINT`（见 resolveRemoteHostFromEnv）。
      // 此前**只有评测脚本**（evals/recall-*-real.mjs）自行设 `env.remoteHost`，生产装配路径
      // 没有任何旋钮 ⇒ 无法直连 huggingface.co 的网络上语义检索**必然不可达**——典型的
      // 「基准脚本绕过装配层给假绿灯」（缺陷形态④）。此处补齐生产入口，使该能力可真正部署。
      // 未配置时为 undefined ⇒ 沿用该库默认源，零行为变更。
      remoteHost: TransformersEmbeddingAdapter.resolveRemoteHostFromEnv(),
    });
    if (TransformersEmbeddingAdapter.shouldPreloadEmbedding()) {
      // L5 预热：把冷启动成本从「首个用户查询」提前到「启动后、接流量前」。
      // **刻意不 await**：装配是同步路径，预热不得阻塞启动；失败由 preload() 自身兜成
      // `{ok:false}` 并落观测（契约保证不抛错），可用性判断仍由首次真实 embed 的 fail-closed 决定。
      void adapter.preload();
    }
    return adapter;
  }
}

// 成本预算（#S29）：设正数硬预算时构造单例，`BudgetedModel` 与 `budget_status` 工具共享
// （含子代同一实例）。非正数 / 未设置即关闭。
//
// 注（2026-09-21）：本段原为 JSDoc 却**没有任何声明跟随其后**（悬空注释）。悬空 JSDoc 会被
// **下一个**声明吸收——文档工具/编辑器会把这段说明挂到别的头上，是实打实的误挂隐患。
// 故降级为普通注释，内容一字未删。
