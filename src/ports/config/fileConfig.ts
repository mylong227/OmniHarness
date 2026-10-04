import type { ModelAdapterId } from '../model/modelAdapterId.js';
import type { SsrfPolicyConfig } from '../security/ssrfPolicyConfig.js';
import type { RbacConfig } from './rbacConfig.js';
import type { SkillEntry } from '../skill/skillEntry.js';
import type { MediaAnalysisConfig } from '../media/mediaAnalysisConfig.js';
import type { FileMcpServer } from './fileMcpServer.js';
import type { PermissionConfig } from './permissionConfig.js';
import type { ProviderPresetConfig } from './providerPresetConfig.js';
import type { ModelRouterConfig } from './modelRouterConfig.js';
import type { CapabilityConfig } from './capabilityConfig.js';

/**
 * 配置文件内容（omniharness.json，端口选择）。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface FileConfig {
  readonly mcpServers?: readonly FileMcpServer[];
  readonly modelAdapter?: ModelAdapterId;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly storageAdapter?: 'memory' | 'jsonl' | 'sqlite';
  readonly storageDir?: string;
  /**
   * 审批档位。`plan` 为只读规划模式（写类工具一律拒绝）——
   * CLI `--approval plan` 早已支持，此前文件枚举漏了它，导致 UI/配置文件无法选中该档
   * （argParser 从文件读 approval 时类型上根本容不下 'plan'）。
   */
  readonly approval?: 'auto' | 'deny' | 'rules' | 'guardian' | 'ask' | 'plan';
  /**
   * 推理强度（#B6，可选）：none / minimal / low / medium / high / xhigh / max，透传为模型 reasoning_effort。
   *
   * 口径更正：TS 类型原只列 5 档，而校验器 `ENUM_VALUES.reasoning` 与厂商预设清单
   * （`providerPresets.reasoningEffort`）早已接受 7 档——两侧不一致会把合法取值卡在类型边界外，
   * 使「文件配置 → CLI」的映射无法类型安全地透传。此处统一为 7 档（**放宽类型，不改校验白名单**）。
   */
  readonly reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly sandbox?:
    'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap' | 'unshare';
  /**
   * 权限参数级规则（A2）：与内置规则合并后交规则审批（`approval: 'rules'` 生效）。
   * 支持 `commandGlob`（`*`/`?` 通配），使「拒绝含某子串的命令」无需改代码即可配置。
   */
  readonly permission?: PermissionConfig;
  /** SSRF / 出站策略表（可配置；缺省用内置默认档）。 */
  readonly ssrfPolicy?: SsrfPolicyConfig;
  /**
   * (F3 RBAC-lite) 角色门禁：`{ enabled, role, roles? }`；缺省关（零行为变更）。
   * 严格校验见 `config/rbacConfigValidator`（未知子键 / 类型不符 / 开了却没给角色都拒绝）。
   */
  readonly rbac?: RbacConfig;
  /**
   * 厂商目录覆盖（#模型接入页，用户指令 2026-09-22）：按 `id` **整体替换**内建预设，
   * 新 `id` **追加**。内建目录随包发布于 `defaults/providers.json`（改数据不改代码），
   * 本字段用于自建/私有化端点与新增厂商。
   *
   * 语义为**整条替换**而非字段级合并：只给 `id` 与个别字段会被校验层拒绝（fail-closed），
   * 避免「没写的字段继承内建值」这种隐式继承在厂商信息变更时静默漂移。
   */
  readonly providerPresets?: readonly ProviderPresetConfig[];
  /**
   * profile 继承（A2）：本 profile 以另一 profile 为父，未声明字段继承父 profile 的值。
   * 仅在 `--profile` 加载的 profile 文件内有效；父 profile 相对本文件所在目录解析。
   */
  readonly extends?: string;
  readonly escalation?: 'deny' | 'ask' | 'auto';
  /**
   * 模型调用熔断（F3）：下游连续失败达阈值即开路，冷却期内快速失败、冷却后半开探测。
   * 缺省开启（与 `modelRetry` 默认开同口径）；`--no-model-circuit-breaker` 可关闭。
   */
  readonly modelCircuitBreaker?: boolean;
  /** 熔断开路阈值（连续失败次数，默认 5）。 */
  readonly modelCircuitBreakerThreshold?: number;
  /** 熔断开路冷却毫秒（默认 30000）。 */
  readonly modelCircuitBreakerOpenMs?: number;
  /**
   * (P5) 成本硬预算（USD）：设正数后按路由定价累计模型花费，越上限即熔断
   * （`costBudgetOnExceed='fail'` 时 fail-closed 阻断后续调用）。0 / 不设为关闭。
   * 此前该字段只能经编程注入（`OmniHarnessConfig.costBudgetUsd`），配置文件与 CLI 均无入口
   * ⇒ 默认部署下成本预算恒为关闭。本字段补齐生产入口。
   */
  readonly costBudgetUsd?: number;
  /** (P5) 预算耗尽行为（默认 'fail'）：'fail' 抛错阻断；'warn' 仅观测（软预算，不阻断）。 */
  readonly costBudgetOnExceed?: 'fail' | 'warn';
  /** (P5) 软阈值比例（相对硬预算，0<r≤1，默认 0.8）：达该比例即置位「建议降级」信号。 */
  readonly costBudgetSoftRatio?: number;
  /**
   * (U4) RLVR 进化闭环：启用后运行时构造「可验证门禁 + RLVR sample-filter-replay」控制器——
   * 每个过门禁的候选再跑一轮 StarPO 采样→可验证奖励（候选代码真实编译/测试绿度）打分→
   * 绿样本进回放缓冲，仅「绿」样本才晋升。缺省关，零破坏。
   * CLI 侧对应 `--evolution-rlvr` / `--rlvr-verify` / `--rlvr-samples` / `--rlvr-min-reward` /
   * `--rlvr-auto-run` / `--rlvr-candidates` / `--rlvr-min-gain`。
   */
  readonly evolutionRlvr?: {
    /** 启用开关（缺省 false）。 */
    readonly enabled?: boolean;
    /** 发现预算上限（默认 12）。 */
    readonly maxCandidates?: number;
    /** 每 prompt 采样数（默认 8）。 */
    readonly samplesPerPrompt?: number;
    /** RLVR 最低保留阈值（默认 0：仅保留 reward>0 的绿样本）。 */
    readonly minReward?: number;
    /** 候选代码验证命令（含 `%CODE_FILE%` 占位符）。缺省则奖励恒 0（无样本进回放，安全旁路）。 */
    readonly verifyCommand?: string;
    /** 门禁须超过基线的最小增益（默认 0.05）。 */
    readonly minGain?: number;
    /** 任务末自动跑一轮（默认 false）。 */
    readonly autoRun?: boolean;
    /**
     * （GEE Kernel v1 · ADR-0008）启用 `EvolutionKernel` 七环编排。缺省 false = 现状路径；
     * CLI 旗标 `--evolution-kernel`。
     */
    readonly kernel?: boolean;
    /** （Kernel 路径）晋升台账落盘目录（默认 `.omniharness/evolution`；S3 起生效）。CLI `--rlvr-ledger-dir`。 */
    readonly ledgerDir?: string;
    /** （Kernel 路径）候选档案每工况桶保留精英上限（默认 4）。CLI `--rlvr-archive-max`。 */
    readonly archiveMaxPerBucket?: number;
  };
  /** 提权复核沙箱（#G3/G4）：profile 亦可覆盖，便于 dev/prod 差异配置。 */
  readonly elevatedSandbox?: 'passthrough' | 'policy' | 'restricted';
  /**
   * 受种技能池（声明式能力包，`SKILL.md` 思路）：命中技能名或 tag 时把 `instructions`
   * 注入系统提示。此前该字段**只有编程入口**（`OmniHarnessConfig.skills`），配置文件与 CLI
   * 均写不进去 ⇒ CLI 用户无法受种任何技能（属功能缺口，见 TASK_BOARD §15.4）。
   *
   * 两个输入通道，同一份校验：
   * - 本配置文件内联数组（键 `skills`）；
   * - CLI `--skills <file.json>`（数组，或 `{ "skills": [...] }`），**追加**在内联之后；
   *   同名以 CLI 为准（否则 `SkillRegistry.register` 的重名保护会直接抛错）。
   *
   * 只接受声明式子集（见 `SkillEntry`）：莫尔/固化等运行时字段不允许由配置注入。
   */
  readonly skills?: readonly SkillEntry[];
  /**
   * (U6) A2A 互操作：启用后运行时起 A2aServer（监听端口）并构造 A2aClient；本端既可被对等
   * 委托、也可委托对端（server 侧任务处理器经子代理运行时跑真实子 agent 完成）。缺省关，零破坏。
   * CLI 侧对应 `--a2a` / `--a2a-port` / `--a2a-peer` / `--a2a-transport`。
   */
  readonly a2a?: {
    /** 是否启用（默认 false）。 */
    readonly enabled?: boolean;
    /** 服务端监听端口（默认 8790，避开 appServer 8787）。 */
    readonly port?: number;
    /** 本端 client 默认对端端点（缺省按 transport 派生：http://…/a2a 或 ws://…/a2a-ws）。 */
    readonly peerEndpoint?: string;
    /** 传输形态（默认 http）。 */
    readonly transport?: 'http' | 'ws';
  };
  readonly workspace?: string;
  /**
   * 媒体抽帧配置（`view_media` 工具）：帧数 / 尺寸 / 字节预算、采样阈值，
   * 以及 `ffmpeg` / `ffprobe` 的显式路径。
   *
   * 与 `OmniHarnessConfig.media` 共用同一份结构（`MediaAnalysisConfig`）；
   * 逐字段校验见 `MediaConfigValidator`（未知 key / 类型不符一律拒绝启动），
   * 数值越界则由 `MediaConfigResolver` 收敛并在工具输出回显生效值。
   */
  readonly media?: MediaAnalysisConfig;
  /**
   * 统一资产协议段（Wave B · ADR-0009）：启用后装配 L1 资产层（类型注册表 + 绞杀者注册表 + 评估器），
   * 技能与工作流模板成为同一协议下的资产。缺省关，零行为变更。
   *
   * 校验见 `CapabilityConfigValidator`（未知子键 / 类型不符 / 档位枚举越界一律拒绝启动）；
   * 与 `OmniHarnessConfig.capability` 共用同一份结构。
   */
  readonly capability?: CapabilityConfig;
  /** 项目工作区列表（UI「添加项目」维护）：绝对路径数组，供工作区面板分组展示与快速切换。 */
  readonly workspaces?: string[];
  /** 激活的插件集 Profile（#G-E/P5.1）：`omniharness profile use <name>` 落盘，serve 启动时默认应用。 */
  readonly pluginProfile?: string;
  readonly maxSteps?: number;
  /** 长期记忆落盘加密（#4.4 Vault 集成）：AES-256-GCM 逐行加密 memory.jsonl。 */
  readonly longTermMemoryEncryption?: boolean;
  /** 加密密钥文件路径（#4.4）：缺省为工作区 .omniharness/longterm/memory.key。 */
  readonly longTermMemoryKeyFile?: string;
  /** 智能模型路由（#B4）：按策略在多个底层模型适配器间路由，fail-closed 严格校验。 */
  readonly modelRouter?: ModelRouterConfig;
  /**
   * 各厂商 API Key 集合（#模型接入页）：厂商标识 → Key。
   * 仅落盘本地配置文件；config.get 回传时一律打码，凭据原文不出服务端。
   */
  readonly providerKeys?: Record<string, string>;
}
