import type { McpServerConfig } from '../../protocols/mcp/mcpGateway.ts';
import type { ExternalCliWorkerSpec } from '../../kernel/worker/externalCliWorker.ts';
import type { SkillEntry } from '../../kernel/skill/skill.ts';
import type {
  ModelRouterConfig,
  PermissionRuleConfig,
  PermissionRuleDecision,
  SsrfPolicyConfig,
} from '../../kernel/config/configFile.ts';
import type { ModelAdapterId } from '../../contracts/ports/model/modelAdapterId.ts';
import type { MediaAnalysisConfig } from '../../kernel/config/mediaConfigResolver.ts';
import type { CapabilityConfig } from '../../contracts/ports/config/capabilityConfig.ts';
import type { RbacConfig } from '../../contracts/ports/config/rbacConfig.ts';
import type { DecisionEngineConfig } from '../../contracts/ports/config/decisionEngineConfig.ts';
import type { RuntimeLimitsConfig } from '../../kernel/util/runtimeLimits.ts';
/**
 * CLI 参数 DTO（2026-10-31 从 argParser.ts 抽出，断开 argParser ⇄ 协作类的依赖环）。
 * 只放类型：默认值实例（CliDefaults）留在 argParser。
 */
/** CLI 参数（DTO：先组装后消费）。 */
export interface CliArgs {
  /** 模型适配器（取值清单见 `ports/model/modelAdapterId.ts`：唯一声明处）。 */
  modelAdapter: ModelAdapterId;
  /** OpenAI 兼容端点地址。 */
  baseUrl?: string | undefined;
  /** 模型 API 密钥（缺省回退对应厂商环境变量）。 */
  apiKey?: string | undefined;
  /** 网络外联白名单（逗号分隔主机后缀）；一旦设置即 fail-closed 收紧（A5）。 */
  networkAllow?: string | undefined;
  /** 模型名（CLI/配置文件显式值优先，适配器内有厂商级兜底）。 */
  model: string;
  /** 会话存储后端（memory/jsonl/sqlite）。 */
  storageAdapter: 'memory' | 'jsonl' | 'sqlite';
  /** 存储目录（jsonl 会话落盘位置或 sqlite 数据库路径）。 */
  storageDir?: string | undefined;
  /** 审批策略（auto/deny/rules/guardian/plan/ask）。 */
  approval: 'auto' | 'deny' | 'rules' | 'guardian' | 'plan' | 'ask';
  /** rules 模式未命中规则时的裁决（allow/deny）。 */
  approvalAsk: 'allow' | 'deny';
  /** 权限参数级规则（A2，来自配置 permission.rules）：与内置规则合并，命中即按其 decision 裁决。 */
  permissionRules?: readonly PermissionRuleConfig[] | undefined;
  /** SSRF / 出站策略表（来自配置 ssrfPolicy；供 CLI 出站守卫与组合根 A2A 使用）。 */
  ssrfPolicy?: SsrfPolicyConfig | undefined;
  /** 运维限制段（来自配置 limits；HTTP/预览源超时、连接数、体积上限；缺省 = 用 defaults/limits.json）。 */
  limits?: RuntimeLimitsConfig | undefined;
  /** 权限规则未命中时的默认裁决（A2，来自配置 permission.defaultDecision；缺省 allow，保持既有零行为变更）。 */
  permissionDefault?: PermissionRuleDecision | undefined;
  /** 沙箱 profile（passthrough 全放行 / policy 默认拦截 / OS 级后端等）。 */
  sandbox:
    | 'passthrough'
    | 'policy'
    | 'restricted'
    | 'windows-native'
    | 'landlock'
    | 'seatbelt'
    | 'bwrap'
    | 'unshare'
    | 'wsl-bwrap'
    | 'container';
  /** 升级审批模式（#G3/G4，默认 deny=fail-closed 不提权）。沙箱拒绝时咨询：ask 交互 / auto 自动（危险动作仍 abort）。 */
  escalation: 'deny' | 'ask' | 'auto';
  /** 提权后的复核沙箱（#G3/G4，默认 policy=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦截。 */
  elevatedSandbox: 'passthrough' | 'policy' | 'restricted';
  /** 事件端口（console 进度走 stderr / silent 静默）。 */
  events: 'console' | 'silent';
  /** 上下文压缩 token 预算（缺省 8000，或按 contextWindow 的 75% 推导）。 */
  compactionMax?: number | undefined;
  /** 外溢后端（#74）：file 落盘可跨重启读回，memory 仅进程内。 */
  spillAdapter: 'memory' | 'file';
  /** 输出超过此字节数触发外溢（留空用内置默认 16384）。 */
  spillMax?: number | undefined;
  /** 外溢后保留的预览字节数（留空用内置默认 2048）。 */
  spillPreview?: number | undefined;
  /** 子智能体最大派生深度（#76，留空用内置默认 2）。 */
  subagentMaxDepth?: number | undefined;
  /** 子智能体并发上限（#76，留空用内置默认 4）。 */
  subagentConcurrency?: number | undefined;
  /** 单个子智能体的步数上限（留空用内置默认 12）。 */
  subagentMaxSteps?: number | undefined;
  /** 自定义工具模块路径列表（--tool，可重复）。 */
  toolFiles: string[];
  /** 任务提示词（位置参数或 --prompt；resume/fork 必填）。 */
  prompt: string;
  /** 工作区根目录（工具读写路径边界）。 */
  workspace: string;
  /** 事件 JSONL 输出文件路径（--output）。 */
  output?: string | undefined;
  /** 待续跑的历史会话 id（--resume）。 */
  resumeId?: string | undefined;
  /** 待分叉的历史会话 id（--fork）。 */
  forkId?: string | undefined;
  /** 待回放的历史会话 id（--replay，无需 prompt）。 */
  replayId?: string | undefined;
  /** 单次任务最大步数：**0 = 不限（缺省）**。终止以任务完成为准，正数才按步数截断。 */
  maxSteps: number;
  /** 待桥接的外部 MCP 服务器清单（--mcp-server，可重复）。 */
  mcpServers: McpServerConfig[];
  /** 外部 CLI worker 规格清单（--worker-external NAME=COMMAND，可重复）。 */
  workerExternals: ExternalCliWorkerSpec[];
  /** 启用 FFI 原生后端（#66）：工具执行路由到 Rust 内核 in-process。 */
  native: boolean;
  /** 计划模式（#77）：开启后未批准计划前拦截写类工具。 */
  planMode?: boolean | undefined;
  /** 提示注入护栏（opt-in 布尔旗标）：`--guard-prompt-injection` 等价 `enforce`；未显式传任何护栏旗标时，生产入口默认 `shadow` 观测档常开（`--guard-prompt-injection-mode off` 可显式关回）。 */
  promptInjectionGuard?: boolean | undefined;
  /**
   * （D1）护栏生效模式：`off` 不跑 / `shadow` 跑但不改行为（只记） / `enforce` 跑且生效。
   * 与 `promptInjectionGuard` 合并解析（后者等价于 enforce），故两者的归一化在 `cliBuildConfig` 一处完成。
   */
  guardPromptInjectionMode?: 'off' | 'shadow' | 'enforce' | undefined;
  /**
   * 推理强度（#B6，来自配置文件 `reasoning` 或环境变量 `OMNIHARNESS_REASONING`；无 CLI 旗标）。
   * 7 档与 `ENUM_VALUES.reasoning` 一致；此前该字段在 CLI 侧**完全缺失** ⇒ 文件/env 写入被静默丢弃。
   */
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  /** （P3）自验证回环（opt-in）：开启后写类工具改写源码时自动跑受限测试并回灌失败摘要（默认关；还须仓库含 npm test 脚本）。 */
  selfVerify?: boolean | undefined;
  /** 延迟加载工具名清单（#M1，逗号分隔）：这些工具默认不进模型上下文，需经 tool_search 发现。 */
  deferTools?: string | undefined;
  /**
   * **（已删除）** `profile?: string` 字段（2026-10-06 第五十七轮 ⑤）。
   *
   * 原声明是"选中的配置 profile 名（#G6，--profile）"，但它**从未被赋值**（FLAG_TABLE 里没有
   * `--profile` 处理器），也**从未被任何代码读取**——`--profile` 实际由**装配层自行扫描 argv**
   * （`cliAgentCmds.loadDefaults` / `cliServerCmds.runServe` → `configFile.loadLayered({profile})`），
   * 在 `CliArgs` 里留一个同名字段只会让下一个人以为"值在这"（`--dump-config` 也从来不含它）。
   * 空声明比没有声明更坏：它是"声明未接线"的一种，且没有任何门禁会报它（I4 只扫被赋值的字段）。
   */
  /** LSP 服务器启动命令（#S32，--lsp "cmd args"）：仅 `lsp` 子命令与配置了 LSP 的代码导航需要；不传则 LSP 不可用。 */
  lsp?: string | undefined;
  /** dump-config：仅打印生效配置（含默认值与配置文件合并结果）并退出，不执行。 */
  dumpConfig?: boolean | undefined;
  /** auto-commit：执行后用 git 自动提交变更。 */
  autoCommit?: boolean | undefined;
  /** 上下文窗口 token 数（--context-window N）：据此在 75% 处自动触发压缩，长会话防上下文溢出。 */
  contextWindow?: number | undefined;
  /**
   * headless / CI 模式（--print / -p，面向 `claude -p` 等 headless 惯例）。
   * 显式声明非交互执行：强制静默过程事件，只把最终结果写到 stdout。
   */
  print?: boolean | undefined;
  /** headless 输出格式（--output-format text|json）：json 供 CI 解析，默认 text。 */
  outputFormat?: 'text' | 'json' | undefined;
  /** 长期记忆落盘加密（#4.4 Vault 集成，--memory-encrypt）：AES-256-GCM 逐行加密 memory.jsonl。 */
  memoryEncrypt?: boolean | undefined;
  /** 加密密钥文件路径（--memory-key-file）：缺省为工作区 .omniharness/longterm/memory.key。 */
  memoryKeyFile?: string | undefined;
  /** 插件集 Profile 名（--plugin-profile，G-E 5.1）：serve/run 启动后把运行时插件集收敛为该命名组合。 */
  pluginProfile?: string | undefined;
  /** 智能模型路由配置（#B4，--model-router '<json>'）：透传进 config.modelRouter。 */
  modelRouter?: ModelRouterConfig | undefined;
  /** 模型路由配置文件路径（#B4，--model-router-file <path>）：读取并 merge 进 config.modelRouter。 */
  modelRouterFile?: string | undefined;
  /** 模型重试开关（V2.1，--no-model-retry 关闭；默认开）：429/408/5xx/网络抖动指数退避重试。 */
  modelRetry?: boolean | undefined;
  /** 模型熔断开关（F3，`--no-model-circuit-breaker` 关闭；默认开）：连续失败达阈值即开路，冷却期快速失败。 */
  modelCircuitBreaker?: boolean | undefined;
  /** 熔断开路阈值（连续失败次数，默认 5）。 */
  modelCircuitBreakerThreshold?: number | undefined;
  /** 熔断开路冷却毫秒（默认 30000）。 */
  modelCircuitBreakerOpenMs?: number | undefined;
  /**
   * F3 凭据水合开关（`--vault-hydrate`；**默认关**）：装配期把加密保险库中的凭据
   * 水合进进程环境，使按 `process.env.X` 读凭据的下游（模型适配器 / 路由）零改动获得回退源。
   * 缺省关 = 零行为变更。
   */
  vaultHydrate?: boolean | undefined;
  /** F3 水合的凭据名（`--vault-hydrate-names a,b`）；省略时用内置默认名列表。 */
  vaultHydrateNames?: readonly string[] | undefined;
  /** F3 保险库主密钥文件（`--vault-key-file`；主密钥优先取环境变量 `OMNIHARNESS_VAULT_KEY`）。 */
  vaultKeyFile?: string | undefined;
  /** F3 密文 KV 后端（`--kv-adapter`，默认 json-file，与 `vault` 子命令同一默认）。 */
  kvAdapter?: 'memory' | 'json-file' | 'sqlite' | undefined;
  /** F3 密文 KV 落盘路径（`--kv-file`）。 */
  kvFile?: string | undefined;
  /**
   * (U4) RLVR 进化闭环开关（`--evolution-rlvr`；**默认关**）：装配期构造「可验证门禁 +
   * RLVR sample-filter-replay」控制器，任务末按 `--rlvr-auto-run` 跑一轮进化。缺省关 = 零行为变更。
   */
  evolutionRlvr?: boolean | undefined;
  /**
   * RLVR 候选代码验证命令（`--rlvr-verify`；含 `%CODE_FILE%` 占位符，运行时替换为临时文件路径）。
   * 例：`node --check %CODE_FILE%`。**缺省则 RLVR 奖励恒 0** → 无绿样本进回放（fail-closed 安全旁路）。
   */
  rlvrVerify?: string | undefined;
  /** RLVR 每 prompt 采样数（`--rlvr-samples`，默认 8）。 */
  rlvrSamples?: number | undefined;
  /** RLVR 最低保留阈值（`--rlvr-min-reward`，默认 0：仅保留 reward>0 的绿样本；>0 时取 r≥阈值）。 */
  rlvrMinReward?: number | undefined;
  /** RLVR 任务末自动跑一轮进化（`--rlvr-auto-run`；默认关）。 */
  rlvrAutoRun?: boolean | undefined;
  /** RLVR 发现预算上限（`--rlvr-candidates`，默认 12）。 */
  rlvrCandidates?: number | undefined;
  /** RLVR 门禁最小增益（`--rlvr-min-gain`，默认 0.05）：候选得分须 ≥ 基线 + 该增益才晋升。 */
  rlvrMinGain?: number | undefined;
  /**
   * （GEE Kernel v1）启用 `EvolutionKernel` 七环编排（`--evolution-kernel`；**默认关**）：
   * 关 = 现状 RLVR 路径；开 = 信号→档案→级联→门禁→台账→晋升→观测全编排。
   */
  evolutionKernel?: boolean | undefined;
  /** （Kernel 路径）晋升台账落盘目录（`--rlvr-ledger-dir`，默认 `.omniharness/evolution`；S3 起生效）。 */
  rlvrLedgerDir?: string | undefined;
  /** （Kernel 路径）候选档案每工况桶精英上限（`--rlvr-archive-max`，默认 4）。 */
  rlvrArchiveMax?: number | undefined;
  /**
   * (U6) A2A 互操作开关（`--a2a`；**默认关**）：运行时起 A2aServer 监听并对接 A2aClient，
   * 本端既可被对等委托、也可委托对端（server 侧跑真实子 agent）。缺省关 = 零行为变更。
   */
  a2a?: boolean | undefined;
  /** A2A 服务端监听端口（`--a2a-port`，默认 8790）。 */
  a2aPort?: number | undefined;
  /** A2A 对端端点（`--a2a-peer`；缺省按 transport 派生本地端点）。 */
  a2aPeer?: string | undefined;
  /** A2A 传输形态（`--a2a-transport http|ws`，默认 http）。 */
  a2aTransport?: 'http' | 'ws' | undefined;
  /** 文本流式输出（V2.1，--stream-text）：模型正文 token 级流式打到 stdout，末尾不再重复打印 finalText。 */
  streamText?: boolean | undefined;
  /** 回合 token 预算（V2.1，--turn-token-budget N）：累计 usage 超限停止步进，交由总结收尾。 */
  turnTokenBudget?: number | undefined;
  /** (P5) 成本硬预算（--cost-budget-usd N，USD）：设正数后按路由定价累计花费，越限熔断。 */
  costBudgetUsd?: number | undefined;
  /** (P5) 预算耗尽行为（--cost-budget-on-exceed fail|warn，默认 fail）：'warn' 为软预算仅观测。 */
  costBudgetOnExceed?: 'fail' | 'warn' | undefined;
  /** (P5) 软阈值比例（--cost-budget-soft-ratio r，0<r≤1，默认 0.8）：达该比例即建议降级。 */
  costBudgetSoftRatio?: number | undefined;
  /**
   * 受种技能池（来自配置文件 `skills` 内联数组）：命中技能名或 tag 时把 instructions
   * 注入系统提示。**声明式子集**——莫尔/固化等运行时字段不由此通道注入（见 `SkillEntry`）。
   */
  skills?: readonly SkillEntry[] | undefined;
  /** 是否允许自动发现工作区 SKILL.md（生产入口按 workspace trust 设置；缺省 true 保持库兼容）。 */
  allowWorkspaceSkills?: boolean | undefined;
  /** `--skills <file.json>`（可重复）：从 JSON 文件追加技能（数组或 `{"skills":[...]}`），同名以旗标为准。 */
  skillsFile?: readonly string[] | undefined;
  /**
   * 媒体抽帧配置（来自配置文件 `media` 键，原样透传到 `OmniHarnessConfig.media`）。
   *
   * 为什么整段透传而不是拆成扁平旗标：这些参数是**展示型预算**（帧数 / 尺寸 / 字节 / 阈值），
   * 逐个开旗标会得到十几个几乎没人记忆的口子（`--media-max-frames` …），而写进配置文件才是
   * 常态用法。整段透传同时保证「配置文件、编程注入」两条路走**同一份结构**（不两套口径）。
   */
  media?: MediaAnalysisConfig | undefined;
  /**
   * （Wave B · ADR-0009）统一资产协议段（来自配置 `capability`；整段透传，与编程注入同一份结构）。
   *
   * **必须在此映射**：接线完整性门禁 I5a 的实测形态就是「FileConfig 收了字段但 CLI 层零引用
   * ⇒ 走 CLI 时配置被静默丢弃」（本仓已有十处同形态）。本字段与 `media`/`ssrfPolicy` 同一条路。
   */
  capability?: CapabilityConfig | undefined;
  /**
   * （F3 RBAC-lite）角色门禁段（来自配置 `rbac`；整段透传）。
   *
   * 与 `capability` 同一条路：**必须在此映射**，否则走 CLI 时 `rbac` 被静默丢弃，
   * 于是「配置里写了角色、实际没人读」——接线完整性门禁 I5a 专拦这一形态。
   */
  rbac?: RbacConfig | undefined;
  /**
   * （Laya 战略线）决策引擎段（来自配置文件 `decisionEngine`；整段透传，与编程注入同一份结构）。
   *
   * **必须在此映射**：这段此前**两条路都不通**——`FileConfig` 里没有这个 key（写进
   * omniharness.json 会被「未知配置项」拒绝），CLI 也没有旗标 ⇒ 生产部署下引擎恒不构造，
   * 项目内 1.7GB 的 venv + 权重零调用。接线完整性门禁 I5a 专拦「FileConfig 收了字段但 CLI
   * 层零引用」这一形态，本字段与 `media` / `capability` / `rbac` 同一条路。
   */
  decisionEngine?: DecisionEngineConfig | undefined;
  /**
   * （Laya 战略线）决策引擎模式旗标取值（`--decision-engine <mode>`；`--no-decision-engine`
   * 等价 `off`）。与配置文件段合并解析，见 `CliDecisionEngineFlags.resolve`。
   */
  decisionEngineMode?: 'off' | 'shadow' | 'enforce' | undefined;
  /** （Laya 战略线）解释器路径旗标取值（`--decision-engine-python <path>`；覆盖配置文件与自动探测）。 */
  decisionEnginePython?: string | undefined;
}
