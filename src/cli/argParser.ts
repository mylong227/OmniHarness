import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpServerConfig } from '../mcp/mcpGateway.js';
import type { SkillEntry } from '../skill/skill.js';
import type {
  FileConfig,
  ModelRouterConfig,
  PermissionRuleConfig,
  PermissionRuleDecision,
  SsrfPolicyConfig,
} from '../config/configFile.js';
import { FLAG_TABLE, VALUE_FLAGS } from './cliFlagTable.js';
import { at } from '../util/arrayAt.js';
import { providerPresets, type ProviderPreset } from '../server/services/providerPresets.js';
import type { ModelAdapterId } from '../ports/model/modelAdapterId.js';
import { cliHelp } from './cliHelp.js';

export * from './cliEnums.js';
export { checkEnum } from './cliFlagTable.js';

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
  /** 权限规则未命中时的默认裁决（A2，来自配置 permission.defaultDecision；缺省 allow，保持既有零行为变更）。 */
  permissionDefault?: PermissionRuleDecision | undefined;
  /** 沙箱 profile（passthrough 全放行 / policy 默认拦截 / OS 级后端等）。 */
  sandbox: 'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap' | 'unshare';
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
  /** 单次任务最大步数（LoopGuard 兜底）。 */
  maxSteps: number;
  /** 待桥接的外部 MCP 服务器清单（--mcp-server，可重复）。 */
  mcpServers: McpServerConfig[];
  /** 真实 dsh worker 的 profile（注册后替代演示 worker）。 */
  workerDsh?: string | undefined;
  /** 启用 FFI 原生后端（#66）：工具执行路由到 Rust 内核 in-process。 */
  native: boolean;
  /** 计划模式（#77）：开启后未批准计划前拦截写类工具。 */
  planMode?: boolean | undefined;
  /** 提示注入护栏（opt-in）：开启后工具结果进上下文前扫描指令注入并隔离命中项（默认关）。 */
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
  /** 选中的配置 profile 名（#G6，--profile）：在 profiles/ 下查找并覆盖项目默认。 */
  profile?: string | undefined;
  /** LSP 服务器启动命令（#S32，--lsp "cmd args"）：仅 `lsp` 子命令与配置了 LSP 的代码导航需要；不传则 LSP 不可用。 */
  lsp?: string | undefined;
  /** dump-config：仅打印生效配置（含默认值与配置文件合并结果）并退出，不执行。 */
  dumpConfig?: boolean | undefined;
  /** auto-commit：执行后用 git 自动提交变更（对标 Aider 的 git 安全网，opt-in）。 */
  autoCommit?: boolean | undefined;
  /** 上下文窗口 token 数（--context-window N）：据此在 75% 处自动触发压缩，长会话防上下文溢出。 */
  contextWindow?: number | undefined;
  /**
   * headless / CI 模式（--print / -p，对标 `claude -p`、`codex exec`）。
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
  /** `--skills <file.json>`（可重复）：从 JSON 文件追加技能（数组或 `{"skills":[...]}`），同名以旗标为准。 */
  skillsFile?: readonly string[] | undefined;
}

/** CLI 默认值。 */
export const CliDefaults: CliArgs = {
  modelAdapter: 'mock',
  model: 'deepseek-v4-flash',
  storageAdapter: 'jsonl',
  storageDir: join(homedir(), '.omniharness', 'sessions'),
  approval: 'rules',
  approvalAsk: 'allow',
  sandbox: 'policy',
  escalation: 'deny',
  elevatedSandbox: 'policy',
  events: 'console',
  spillAdapter: 'file',
  toolFiles: [],
  prompt: '',
  workspace: process.cwd(),
  maxSteps: 16,
  mcpServers: [],
  native: true,
  planMode: false,
};

/** 适配器厂商预设（id + baseUrl）——完整形状见 `config/providerPresets.ts` 的 `ProviderPreset`。 */
type AdapterPreset = ProviderPreset;

/**
 * CLI 参数解析器：原模块级纯函数归拢为 `ArgParser` 方法族，现改为实例方法以消除 `static`；
 * 调用点通过同名门面函数零改动继续引用；`CliDefaults` / `CliArgs` / re-export 保持不变。
 */
export class ArgParser {
  /**
   * 收集非旗标的位置参数（回退为 prompt，如 `omniharness "fix bug"`）。
   * @param argv 原始命令行参数。
   * @returns 位置参数列表（按出现顺序；旗标本身及其取值不计入）。
   */
  private collectPositional(argv: readonly string[]): string[] {
    const out: string[] = [];
    for (let k = 0; k < argv.length; k += 1) {
      const a = argv[k];
      if (a === undefined || a.startsWith('--')) {
        continue;
      }
      const prev = argv[k - 1];
      if (prev !== undefined && VALUE_FLAGS.has(prev)) {
        continue;
      }
      out.push(a);
    }
    return out;
  }

  /**
   * 把 GitBash / MSYS 风格路径（如 `/d/deepseek/x`）转换为本机 Windows 路径（`D:\deepseek\x`）。
   * Windows 上 node 的 path.join 不会解析 `/d/...`，会把它当成「当前盘符根下的 \d\...」，
   * 导致配置文件/工作区落到错位目录（如 D:\d\deepseek\...）。serve 在 GitBash 下接收的参数
   * 多为该风格，统一在此转换，避免 fs.list / config.update 落盘路径错乱。
   * @param p 任意风格路径。
   * @returns 本机 Windows 风格路径（非 MSYS 风格输入原样返回，仅统一分隔符）。
   */
  public toWindowsPath(p: string): string {
    let s = p.trim();
    const drive = s.match(/^\/([a-zA-Z])\/(.*)$/);
    if (drive !== null) {
      s = `${at(drive, 1).toUpperCase()}:/${at(drive, 2)}`;
    }
    return s.replace(/\//g, '\\');
  }

  /**
   * 解析 CLI 参数：以 CliDefaults（可被 defaults 覆盖）为基底，逐个消费 argv 中的旗标
   * （查 FLAG_TABLE 调用处理器；遇 --help 直接返回 undefined），最后把非旗标位置参数
   * 回填为 prompt（prompt 为空时）。resume/fork 模式必须显式提供 --prompt。
   * @param argv 原始命令行参数（不含 node 与脚本入口两个元素）
   * @param defaults 额外默认值（如配置文件合并结果），逐字段覆盖在 CliDefaults 之上
   * @returns 解析后的完整参数；undefined 表示 --help，或既无 prompt 又无 --replay（无事可做）
   * @throws resume/fork 模式缺 --prompt 时抛错
   */
  public parseArgs(argv: readonly string[], defaults?: Partial<CliArgs>): CliArgs | undefined {
    const args: CliArgs = { ...CliDefaults, ...(defaults ?? {}) };
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === undefined) {
        continue;
      }
      if (arg === '--help') {
        return undefined;
      }
      const handler = FLAG_TABLE[arg];
      if (handler !== undefined) {
        i += handler(args, argv, i);
        continue;
      }
    }
    const positional = this.collectPositional(argv);
    if (args.prompt === '' && positional.length > 0) {
      args.prompt = positional.join(' ');
    }
    if (args.dumpConfig) {
      return args;
    }
    if (args.prompt === '' && args.replayId === undefined) {
      return undefined;
    }
    if (args.prompt === '' && (args.resumeId !== undefined || args.forkId !== undefined)) {
      throw new Error('resume/fork 模式需要 --prompt');
    }
    return args;
  }

  /**
   * 配置文件 → CLI 默认参数（仅合并已定义字段）。
   * @param file 已加载的项目配置文件对象。
   * @returns 可覆盖在 CliDefaults 之上的默认值子集（providerKeys 会按适配器补全 apiKey/baseUrl）。
   */
  public configDefaults(file: FileConfig): Partial<CliArgs> {
    const result: Partial<CliArgs> = {};
    if (file.reasoning !== undefined) {
      result.reasoning = file.reasoning;
    }
    if (file.mcpServers !== undefined) {
      result.mcpServers = file.mcpServers.map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
      }));
    }
    // 受种技能池：配置文件内联数组直接进 CLI 参数；`--skills <file.json>` 在装配层追加（同名以旗标为准）。
    if (file.skills !== undefined) {
      result.skills = file.skills;
    }
    if (file.modelAdapter !== undefined) {
      result.modelAdapter = file.modelAdapter;
    }
    if (file.baseUrl !== undefined) {
      result.baseUrl = file.baseUrl;
    }
    if (file.apiKey !== undefined) {
      result.apiKey = file.apiKey;
    }
    // 兜底：顶层凭据缺失时按 providerKeys 命中的厂商预设补全（见 fillProviderCredentials）。
    this.fillProviderCredentials(file, result);
    if (file.model !== undefined) {
      result.model = file.model;
    }
    if (file.storageAdapter !== undefined) {
      result.storageAdapter = file.storageAdapter;
    }
    if (file.storageDir !== undefined) {
      result.storageDir = file.storageDir;
    }
    if (file.approval !== undefined) {
      result.approval = file.approval;
    }
    // 权限参数级规则（A2）：配置 permission 段透传给装配层，与内置规则合并。
    if (file.permission?.rules !== undefined) {
      result.permissionRules = file.permission.rules;
    }
    if (file.permission?.defaultDecision !== undefined) {
      result.permissionDefault = file.permission.defaultDecision;
    }
    // SSRF 策略表（可配置）：**修「声明未接线」**——本函数此前从不映射 `file.ssrfPolicy`，
    // 于是 `args.ssrfPolicy` 恒为 undefined，写在 omniharness.json 里的策略表从未到达
    // 出站守卫与组合根（只有编程 API 路径生效）。接线完整性门禁 I5a 只对 src/cli 做字符串
    // 匹配（`args.ssrfPolicy` 足以命中），因此这条断链长期是绿的——2026-09-22 第二轮实测发现。
    if (file.ssrfPolicy !== undefined) {
      result.ssrfPolicy = file.ssrfPolicy;
    }
    if (file.sandbox !== undefined) {
      result.sandbox = file.sandbox;
    }
    if (file.escalation !== undefined) {
      result.escalation = file.escalation;
    }
    if (file.modelCircuitBreaker !== undefined) {
      result.modelCircuitBreaker = file.modelCircuitBreaker;
    }
    if (file.modelCircuitBreakerThreshold !== undefined) {
      result.modelCircuitBreakerThreshold = file.modelCircuitBreakerThreshold;
    }
    if (file.modelCircuitBreakerOpenMs !== undefined) {
      result.modelCircuitBreakerOpenMs = file.modelCircuitBreakerOpenMs;
    }
    // (P5) 成本预算：文件对象形态 → 扁平 CliArgs 字段（CLI 旗标在更上层继续覆盖）。
    if (file.costBudgetUsd !== undefined) {
      result.costBudgetUsd = file.costBudgetUsd;
    }
    if (file.costBudgetOnExceed !== undefined) {
      result.costBudgetOnExceed = file.costBudgetOnExceed;
    }
    if (file.costBudgetSoftRatio !== undefined) {
      result.costBudgetSoftRatio = file.costBudgetSoftRatio;
    }
    if (file.elevatedSandbox !== undefined) {
      result.elevatedSandbox = file.elevatedSandbox;
    }
    if (file.workspace !== undefined) {
      result.workspace = file.workspace;
    }
    if (file.maxSteps !== undefined) {
      result.maxSteps = file.maxSteps;
    }
    if (file.modelRouter !== undefined) {
      result.modelRouter = file.modelRouter;
    }
    // (U4) RLVR 进化闭环：文件对象形态 → 扁平 CliArgs 字段（CLI 旗标在更上层继续覆盖）。
    if (file.evolutionRlvr !== undefined) {
      if (file.evolutionRlvr.enabled !== undefined) {
        result.evolutionRlvr = file.evolutionRlvr.enabled;
      }
      if (file.evolutionRlvr.verifyCommand !== undefined) {
        result.rlvrVerify = file.evolutionRlvr.verifyCommand;
      }
      if (file.evolutionRlvr.samplesPerPrompt !== undefined) {
        result.rlvrSamples = file.evolutionRlvr.samplesPerPrompt;
      }
      if (file.evolutionRlvr.minReward !== undefined) {
        result.rlvrMinReward = file.evolutionRlvr.minReward;
      }
      if (file.evolutionRlvr.maxCandidates !== undefined) {
        result.rlvrCandidates = file.evolutionRlvr.maxCandidates;
      }
      if (file.evolutionRlvr.minGain !== undefined) {
        result.rlvrMinGain = file.evolutionRlvr.minGain;
      }
      if (file.evolutionRlvr.autoRun !== undefined) {
        result.rlvrAutoRun = file.evolutionRlvr.autoRun;
      }
    }
    // (U6) A2A 互操作：文件对象形态 → 扁平 CliArgs 字段（CLI 旗标在更上层继续覆盖）。
    if (file.a2a !== undefined) {
      if (file.a2a.enabled !== undefined) {
        result.a2a = file.a2a.enabled;
      }
      if (file.a2a.port !== undefined) {
        result.a2aPort = file.a2a.port;
      }
      if (file.a2a.peerEndpoint !== undefined) {
        result.a2aPeer = file.a2a.peerEndpoint;
      }
      if (file.a2a.transport !== undefined) {
        result.a2aTransport = file.a2a.transport;
      }
    }
    return result;
  }

  /**
   * 凭据兜底：顶层 `apiKey` / `baseUrl` 缺失时，用 `providerKeys` 里命中的厂商预设补全。
   *
   * 由来：修复 #OBS-2「UI 用 providerKeys 配的 key，CLI 启动却因缺 apiKey 崩」——
   * 按 `modelAdapter` 枚举所有可能厂商预设，取第一个在 `providerKeys` 里有 key 的。
   * 目录用**生效目录**（内建 `defaults/providers.json` + 用户 `providerPresets` 覆盖），
   * 自建/私有化厂商同样能被命中（否则 UI 配了 Key、CLI 却认不到该厂商）。
   * @param file 已加载的分层配置。
   * @param result 正在组装的 CLI 默认值（原地写入 `apiKey` / `baseUrl`）。
   * @returns 无返回值（无适配器声明或凭据已齐时直接返回）。
   */
  private fillProviderCredentials(file: FileConfig, result: Partial<CliArgs>): void {
    if (file.modelAdapter === undefined) return;
    if (file.apiKey !== undefined && file.baseUrl !== undefined) return;
    const providerKeys = file.providerKeys ?? {};
    const effectivePresets = providerPresets.resolve(file.providerPresets);
    for (const preset of this.adapterPresets(file.modelAdapter, effectivePresets)) {
      const presetKey = providerKeys[preset.id];
      if (presetKey !== undefined) {
        if (file.apiKey === undefined) result.apiKey = presetKey;
        if (file.baseUrl === undefined) result.baseUrl = preset.baseUrl;
        return;
      }
    }
  }

  /**
   * 打印用法。
   * @returns 无返回值。
   */
  /** 打印用法（文案在 `defaults/cliHelp.json`；枚举取值在渲染时从 `cliEnums` 派生）。
   * @returns 无返回值。
   */
  public printUsage(): void {
    process.stdout.write(cliHelp.render());
  }

  /**
   * 提取错误消息。
   * @param error 任意抛出值。
   * @returns Error 实例取 message，其余取 String(error)。
   */
  public messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 按 CLI `--model-adapter` 反查厂商预设。
   *
   * 来源为**单一目录**（`config/providerPresets.ts`，数据在 `defaults/providers.json`）：
   * 本类此前独立维护一份手工副本 `ADAPTER_PRESETS`（注释自称「同源同步」），加一家厂商要改两处、
   * 且两处漂移会出现「UI 有这家厂商、CLI 解析不到」的隐性缺口——已删除。CLI 专属映射
   * （`responses` → openai、`llamacpp` → ollama）改由预设自带的 `cliAdapters` 数据表达。
   * @param adapter CLI `--model-adapter` 取值。
   * @param presets 生效目录（缺省内建目录；调用方传 `providerPresets.resolve(file.providerPresets)`
   *   以纳入 `omniharness.json` 的用户覆盖）。
   * @returns 首个厂商预设；适配器无预设时返回 undefined。
   */
  public adapterToPreset(
    adapter: string,
    presets?: readonly ProviderPreset[],
  ): AdapterPreset | undefined {
    const list = this.adapterPresets(adapter, presets);
    return list.length === 0 ? undefined : list[0];
  }

  /**
   * 取适配器下所有可能厂商预设（按 baseUrl 一一对应）。
   * @param adapter CLI `--model-adapter` 取值。
   * @param presets 生效目录（缺省内建目录）。
   * @returns 预设列表（未知适配器返回空数组）。
   */
  public adapterPresets(
    adapter: string,
    presets?: readonly ProviderPreset[],
  ): readonly AdapterPreset[] {
    return providerPresets.forAdapter(adapter, presets);
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const argParser = new ArgParser();

/** GitBash / MSYS 路径 → 本机 Windows 路径。 */
export function toWindowsPath(p: string): string {
  return argParser.toWindowsPath(p);
}

/** 解析 CLI 参数（`undefined` 表示 --help 或无任务）。 */
export function parseArgs(
  argv: readonly string[],
  defaults?: Partial<CliArgs>,
): CliArgs | undefined {
  return argParser.parseArgs(argv, defaults);
}

/** 配置文件 → CLI 默认参数。 */
export function configDefaults(file: FileConfig): Partial<CliArgs> {
  return argParser.configDefaults(file);
}

/** 打印用法。 */
export function printUsage(): void {
  argParser.printUsage();
}

/** 提取错误消息。 */
export function messageOf(error: unknown): string {
  return argParser.messageOf(error);
}

/** 按适配器反查首个厂商预设（`presets` 可传生效目录以纳入用户覆盖）。 */
export function adapterToPreset(
  adapter: string,
  presets?: readonly ProviderPreset[],
): AdapterPreset | undefined {
  return argParser.adapterToPreset(adapter, presets);
}

/** 取适配器下所有厂商预设（`presets` 可传生效目录以纳入用户覆盖）。 */
export function adapterPresets(
  adapter: string,
  presets?: readonly ProviderPreset[],
): readonly AdapterPreset[] {
  return argParser.adapterPresets(adapter, presets);
}
