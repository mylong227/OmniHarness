import type { ModelPort, RoutePrice } from '../model/model.js';
import type { StoragePort } from '../memory/storage.js';
import type { ApprovalPort } from '../runtime/approval.js';
import type { SandboxPort } from '../runtime/sandbox.js';
import type { EventPort } from '../runtime/eventPort.js';
import type { ToolPort } from '../tool/tool.js';
import type { ExtraTool } from '../tool/extraTool.js';
import type { SpillPort } from '../memory/spill.js';
import type { WorkerRegistry } from '../../worker/workerRegistry.js';
import type { UserResponder } from '../runtime/userResponder.js';
import type { TodoPort } from '../runtime/todo.js';
import type { PlanPort } from '../runtime/plan.js';
import type { RetrievalPort } from '../intelligence/retrieval.js';
import type { EscalationPort } from '../runtime/escalation.js';
import type { AgentIdentityConfig } from '../runtime/agentIdentity.js';
import type { LongTermMemoryPort } from '../memory/longTermMemory.js';
import type { ToolInputSink } from '../tool/toolInputSink.js';
import type { EvolutionController } from '../runtime/evolution.js';
import type { SelfVerifyConfig } from './selfVerifyConfig.js';
import type { DecisionEngineConfig } from './decisionEngineConfig.js';
import type { EnforcementMode } from '../security/enforcementMode.js';
import type { TrustTier } from '../../security/toolOutputTrust.js';
import type { MediaAnalysisConfig } from '../media/mediaAnalysisConfig.js';
import type { SsrfPolicyConfig } from '../security/ssrfPolicyConfig.js';
import type { RuntimeTelemetryPort } from '../runtime/runtimeTelemetry.js';
import type { RegimeSignals } from '../genesis/regimeSignals.js';
import type { Skill } from '../../skill/skill.js';
import type { LspServerConfig } from '../tool/lsp.js';
import type { ModelRouterConfig } from './modelRouterConfig.js';

/** OmniHarness运行时配置：端口注入即插即用，核心无第三方依赖具体实现。 */
/**
 * （P3）自验证回环配置：写源码后自动跑受限测试并回灌失败摘要。
 *
 * 默认全部保守：超时 120s、输出上限 256 KiB、冷却 60s、每会话最多 3 次、摘要 15 行。
 * `enabled === true` 后取命令的优先级：**显式 `command` 直接生效**（不受「仓库有测试症状」闸门约束）；
 * 未给 `command` 时由 `SelfVerifyCommandDetector` 从仓库证据推断（npm / pytest / cargo / go /
 * maven / gradle / rspec / dotnet / make）；两者皆无则不启用（fail-closed）。
 */
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
  /**
   * 是否把 token 记账下沉到原生内核（G8，2026-10-03；**默认 false ＝ 走 TS**）。
   *
   * ## 为什么默认关（而不是"有原生就用"）
   *
   * 本机实测（报告 §3.8 发现 1）：同语料 1,108 条 / 775,600 字符，TS 纯计数 **6.12 ms**，
   * 走 native `context.estimate` **27.8–40.7 ms（慢 4.5–6.7×）**。根因是**封送成本占主导**
   * （`JSON.stringify` 单项 12.08 ms / 925 KB，占 native 全往返 29.7%），且 Rust 侧无缓存，
   * 而 TS 侧已有 LRU + 零分配。⇒ "下沉 Rust 即加速"在本路径上是**净亏**。
   *
   * ## 为什么翻转默认是安全的
   *
   * 两条路径**逐位相同**（既有断言：`native` 估算与 JS 结果一致）⇒ 翻转只去掉了额外延迟，
   * 不改变任何记账结果。需要原生路径时显式开启（配置或 `OMNI_NATIVE_TOKEN_ACCOUNTING=1`）。
   */
  readonly nativeTokenAccounting?: boolean | undefined;
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
  /** Agent 密码学身份配置（#S33，可选）：声明 Ed25519 私钥（PKCS#8 der base64）与 runtime id；不配则每次运行生成临时身份、且不注册 `agent_identity` 工具。无第三方依赖（仅 Node 内置 node:crypto）。 */
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
  /** LSP 代码导航服务器配置（#S32，可选）：声明如何启动外部语言服务器；不配则 LSP 工具不注册。无第三方依赖——服务器由用户自备（如 typescript-language-server）。运行时端口见 `ResolvedConfig.lsp`。 */
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
  /** 提示注入护栏（opt-in，默认关）：开启后工具结果进模型上下文前做确定性指令注入扫描，命中即隔离（不喂给模型）。无第三方依赖、纯规则启发式、失败开放（扫描器异常时放行原始结果）。 */
  readonly promptInjectionGuard?: boolean | EnforcementMode | undefined;
  /**
   * 注入护栏弱证据处置策略（P4 升档旋钮，可选）：`enforce` 档下弱规则命中（`severity: 'weak'`）
   * 按本策略决定——`'block'` 隔离、`'observe'` 仅记录不隔离（降误伤）。缺省 undefined 视作 `'block'`，
   * 保持既有 enforce 语义（强弱都拦）。强规则命中（`severity: 'strong'`）恒隔离，不受本策略影响。
   */
  readonly promptInjectionGuardWeakPolicy?: 'block' | 'observe' | undefined;
  /**
   * 注入护栏各来源信任级弱证据阈值覆盖（P4 升档旋钮，可选）：`Partial<Record<TrustTier, number>>`，
   * 未给的档沿用 `ToolOutputTrust` 内置基线（external/unknown=1、file=2、local=3）。改变「弱证据达到
   * 多少条才判为注入」的灵敏度。
   */
  readonly promptInjectionGuardThresholds?: Partial<Record<TrustTier, number>> | undefined;
  /**
   * （P3）自验证回环（opt-in，默认关）：开启后**写类工具改写源码**时自动跑受限测试命令，
   * 把失败摘要回灌到该次工具结果（模型同一步即知「改坏了」），并复用 `SelfChecklist` 做假完成探测。
   *
   * 生效还须**仓库有测试症状**（`package.json` 含 `scripts.test`），否则静默不启用。
   * 纪律：不进主门禁、可关、有超时与预算上限（见各字段默认值）。
   */
  readonly selfVerify?: SelfVerifyConfig | undefined;
  /** （Laya 战略线）决策引擎：用本地 System-1 推理替代 LLM 长推理做高频结构化判断。默认 off（零行为）。 */
  readonly decisionEngine?: DecisionEngineConfig | undefined;
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
   * 媒体抽帧配置（`view_media` 工具）：帧数 / 尺寸 / 字节预算、采样阈值，以及
   * `ffmpeg`/`ffprobe` 的显式路径。全字段可选，缺省见 `MediaConfigResolver` 的默认值
   * （配置 > 环境变量 > 内置默认，且数值一律收敛到安全区间）。
   *
   * 配置文件（`omniharness.json` 的 `media` 键）与 CLI 共用同一份结构，故这里不再拆成
   * 十几个扁平旗标 —— 但字段仍逐个声明（不是 `Record<string, unknown>`），
   * 未知子键会被 `ConfigError` 拒绝，避免「写错了却不生效」。
   */
  readonly media?: MediaAnalysisConfig | undefined;
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
