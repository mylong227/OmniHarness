import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileLoader } from './profileLoader.js';
import {
  ConfigError,
  loadBundlePatchLayer,
  mergeConfigs,
  normalizeConfig,
  readEnvConfig,
} from './configError.js';

/** 配置文件里的 MCP 服务器声明。 */
export interface FileMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
}

/** 权限规则裁决（配置文件形态）。 */
export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

/**
 * 单条权限规则（配置文件形态）：工具级 + 命令级（前缀或 glob）约束。
 *
 * 与适配层的 `ApprovalRule` 结构等价但**分层独立**——配置层不依赖适配层（六边形依赖方向）。
 * 装配时由 CLI 构建层映射为 `ApprovalRule`。
 */
export interface PermissionRuleConfig {
  /** 限定工具名（未声明则不限制工具）。 */
  readonly toolName?: string;
  /** 命令前缀约束（`startsWith` 匹配）。 */
  readonly commandPrefix?: string;
  /** 命令 glob 约束（`*` 任意串 / `?` 单字符，整串匹配）。 */
  readonly commandGlob?: string;
  /** 命中后的裁决。 */
  readonly decision: PermissionRuleDecision;
}

/**
 * 权限配置段（omniharness.json 的 `permission` 字段）。
 *
 * 用于把「多档权限」的参数级规则外置为可配置项：`rules` 与内置规则合并后交规则审批，
 * 使「拒绝任何含 `curl | sh` 的命令」这类策略无需改代码即可生效。
 */
export interface PermissionConfig {
  /** 用户自定义规则（与内置规则合并，聚合语义 deny 优先）。 */
  readonly rules?: readonly PermissionRuleConfig[];
  /** 规则未命中时的默认裁决（缺省 allow，保持既有零行为变更）。 */
  readonly defaultDecision?: PermissionRuleDecision;
}

/** 配置文件内容（omniharness.json，端口选择）。 */
export interface FileConfig {
  readonly mcpServers?: readonly FileMcpServer[];
  readonly modelAdapter?: 'mock' | 'openai' | 'anthropic' | 'responses' | 'llamacpp';
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
  /** 推理强度（#B6，可选）：minimal / low / medium / high / xhigh，透传为模型 reasoning_effort。 */
  readonly reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly sandbox?: 'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap';
  /**
   * 权限参数级规则（A2）：与内置规则合并后交规则审批（`approval: 'rules'` 生效）。
   * 支持 `commandGlob`（`*`/`?` 通配），使「拒绝含某子串的命令」无需改代码即可配置。
   */
  readonly permission?: PermissionConfig;
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
  };
  /** 提权复核沙箱（#G3/G4）：profile 亦可覆盖，便于 dev/prod 差异配置。 */
  readonly elevatedSandbox?: 'passthrough' | 'policy' | 'restricted';
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

/** 模型路由条目配置（底层适配器 + 模型名 + 可选定价）。 */
export interface ModelRouterEntryConfig {
  readonly model: string;
  /** 底层适配器类型（缺省 mock）；构造时复用既有的模型适配器逻辑。 */
  readonly adapter?: string;
  /** 每千 token 定价（USD），least-cost 用。 */
  readonly pricing?: { readonly inputPer1k: number; readonly outputPer1k: number };
}

/** 模型路由配置（#B4）。 */
export interface ModelRouterConfig {
  readonly strategy: string;
  readonly entries: readonly ModelRouterEntryConfig[];
  /** by-task 策略下仅匹配该 role 的消息（可选）。 */
  readonly taskField?: string;
}

/** loadLayered 的参数。 */
export interface LayeredOptions {
  readonly workspace: string;
  /** 显式配置文件路径（--config），优先于向上查找。 */
  readonly configPath?: string;
  /** 选中的 profile 名（--profile），PATH 在 profiles/ 下查找。 */
  readonly profile?: string;
}

/** 配置文件加载器：omniharness.json，向上逐级查找（无隐式状态，默认实例见文件末尾）。 */
export class ConfigFile {
  /** 配置文件固定名。 */
  public readonly FILE_NAME = 'omniharness.json';

  /** 从目录向上查找配置文件。 */
  public find(startDir: string): string | undefined {
    let current = startDir;
    while (true) {
      const candidate = join(current, this.FILE_NAME);
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  /** 加载并解析配置文件（文件不存在返回空配置，宽松：不校验未知 key）。 */
  public load(filePath: string): FileConfig {
    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as FileConfig;
    } catch {
      return {};
    }
  }

  /**
   * 写回配置文件（落盘）：先归一化校验（未知 key / 枚举越界 / 类型错误 fail-closed 抛 ConfigError），
   * 目录不存在自动创建，输出 pretty JSON。供 AppServer.config.update 持久化 UI 设置。
   
 * @returns 无返回值。
*/
  public save(filePath: string, cfg: FileConfig): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const normalized = normalizeConfig(cfg as Record<string, unknown>);
    writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  }

  /**
   * 分层加载并严格合并配置（#G6）：
   *   用户级 ~/.omniharness/omniharness.json → 项目级 omniharness.json → profile → 环境变量
   * 各层（除环境变量层，它天然只含已知 key）经 normalizeConfig 严格校验，未知 key / 枚举越界 / 类型错误
   * 一律 fail-closed 抛 ConfigError。合并语义为「非零值覆盖」，CLI 参数在更上层（parseArgs）继续覆盖。
   */
  public loadLayered(opts: LayeredOptions): FileConfig {
    const layers: Partial<FileConfig>[] = [];

    // 用户级：固定路径 ~/.omniharness/omniharness.json（若存在）。
    const userPath = join(homedir(), '.omniharness', 'omniharness.json');
    if (existsSync(userPath)) {
      layers.push(this.readStrict(userPath));
    }

    // 项目级：显式 --config 优先，否则向上查找。
    const projectPath = opts.configPath ?? this.find(opts.workspace);
    if (projectPath !== undefined && existsSync(projectPath)) {
      layers.push(this.readStrict(projectPath));
    }

    // profile 层：仅当指定 --profile 时加载（覆盖项目默认）。
    if (opts.profile !== undefined) {
      const profilePath = profileLoader.find(opts.workspace, opts.profile);
      if (profilePath === undefined) {
        throw new ConfigError(
          `未找到 profile "${opts.profile}"（查找 ./profiles/<name>.json 与 ~/.omniharness/profiles/<name>.json）`,
        );
      }
      layers.push(profileLoader.load(profilePath));
    }

    // bundle 补丁层（G-E 5.2/5.3）：由 `bundle unpack` 写出的 config 覆盖，叠在 profile 之上、
    // 低于显式 env。放在 env 之前插入，使发布单元携带的推荐配置在运行时生效。
    layers.push(loadBundlePatchLayer(opts.workspace));

    // 环境变量层：最高优先级（仍低于 CLI 参数）。
    layers.push(readEnvConfig());

    return mergeConfigs(...layers);
  }

  /** 读文件并严格归一化（未知 key / 枚举越界 / 类型错误抛 ConfigError）。 */
  private readStrict(filePath: string): FileConfig {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new ConfigError(`无法读取配置文件 ${filePath}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`配置文件 ${filePath} 不是合法 JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigError(`配置文件 ${filePath} 顶层应为对象`);
    }
    return normalizeConfig(parsed as Record<string, unknown>);
  }
}

// ---- 组合根门面：默认加载器实例（调用点以 `configFile.xxx` 零构造复用） ----
/** 默认配置文件加载器实例（无状态）。 */
export const configFile = new ConfigFile();
