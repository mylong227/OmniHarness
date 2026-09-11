import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpServerConfig } from '../mcp/mcpGateway.js';
import type { FileConfig, ModelRouterConfig } from '../config/configFile.js';
import { FLAG_TABLE, VALUE_FLAGS } from './cliFlagTable.js';

export * from './cliEnums.js';
export { checkEnum } from './cliFlagTable.js';

/** CLI 参数（DTO：先组装后消费）。 */
export interface CliArgs {
  modelAdapter: 'mock' | 'openai' | 'anthropic' | 'responses' | 'llamacpp';
  baseUrl?: string;
  apiKey?: string;
  /** 网络外联白名单（逗号分隔主机后缀）；一旦设置即 fail-closed 收紧（A5）。 */
  networkAllow?: string;
  model: string;
  storageAdapter: 'memory' | 'jsonl' | 'sqlite';
  storageDir?: string;
  approval: 'auto' | 'deny' | 'rules' | 'guardian' | 'plan' | 'ask';
  approvalAsk: 'allow' | 'deny';
  sandbox: 'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap';
  /** 升级审批模式（#G3/G4，默认 deny=fail-closed 不提权）。沙箱拒绝时咨询：ask 交互 / auto 自动（危险动作仍 abort）。 */
  escalation: 'deny' | 'ask' | 'auto';
  /** 提权后的复核沙箱（#G3/G4，默认 policy=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦截。 */
  elevatedSandbox: 'passthrough' | 'policy' | 'restricted';
  events: 'console' | 'silent';
  compactionMax?: number;
  /** 外溢后端（#74）：file 落盘可跨重启读回，memory 仅进程内。 */
  spillAdapter: 'memory' | 'file';
  /** 输出超过此字节数触发外溢（留空用内置默认 16384）。 */
  spillMax?: number;
  /** 外溢后保留的预览字节数（留空用内置默认 2048）。 */
  spillPreview?: number;
  /** 子智能体最大派生深度（#76，留空用内置默认 2）。 */
  subagentMaxDepth?: number;
  /** 子智能体并发上限（#76，留空用内置默认 4）。 */
  subagentConcurrency?: number;
  /** 单个子智能体的步数上限（留空用内置默认 12）。 */
  subagentMaxSteps?: number;
  toolFiles: string[];
  prompt: string;
  workspace: string;
  output?: string;
  resumeId?: string;
  forkId?: string;
  replayId?: string;
  maxSteps: number;
  mcpServers: McpServerConfig[];
  /** 真实 dsh worker 的 profile（注册后替代演示 worker）。 */
  workerDsh?: string;
  /** 启用 FFI 原生后端（#66）：工具执行路由到 Rust 内核 in-process。 */
  native: boolean;
  /** 计划模式（#77）：开启后未批准计划前拦截写类工具。 */
  planMode?: boolean;
  /** 提示注入护栏（opt-in）：开启后工具结果进上下文前扫描指令注入并隔离命中项（默认关）。 */
  promptInjectionGuard?: boolean;
  /** 延迟加载工具名清单（#M1，逗号分隔）：这些工具默认不进模型上下文，需经 tool_search 发现。 */
  deferTools?: string;
  /** 选中的配置 profile 名（#G6，--profile）：在 profiles/ 下查找并覆盖项目默认。 */
  profile?: string;
  /** LSP 服务器启动命令（#S32，--lsp "cmd args"）：仅 `lsp` 子命令与配置了 LSP 的代码导航需要；不传则 LSP 不可用。 */
  lsp?: string;
  /** dump-config：仅打印生效配置（含默认值与配置文件合并结果）并退出，不执行。 */
  dumpConfig?: boolean;
  /** auto-commit：执行后用 git 自动提交变更（对标 Aider 的 git 安全网，opt-in）。 */
  autoCommit?: boolean;
  /** 上下文窗口 token 数（--context-window N）：据此在 75% 处自动触发压缩，长会话防上下文溢出。 */
  contextWindow?: number;
  /**
   * headless / CI 模式（--print / -p，对标 `claude -p`、`codex exec`）。
   * 显式声明非交互执行：强制静默过程事件，只把最终结果写到 stdout。
   */
  print?: boolean;
  /** headless 输出格式（--output-format text|json）：json 供 CI 解析，默认 text。 */
  outputFormat?: 'text' | 'json';
  /** 长期记忆落盘加密（#4.4 Vault 集成，--memory-encrypt）：AES-256-GCM 逐行加密 memory.jsonl。 */
  memoryEncrypt?: boolean;
  /** 加密密钥文件路径（--memory-key-file）：缺省为工作区 .omniharness/longterm/memory.key。 */
  memoryKeyFile?: string;
  /** 插件集 Profile 名（--plugin-profile，G-E 5.1）：serve/run 启动后把运行时插件集收敛为该命名组合。 */
  pluginProfile?: string;
  /** 智能模型路由配置（#B4，--model-router '<json>'）：透传进 config.modelRouter。 */
  modelRouter?: ModelRouterConfig;
  /** 模型路由配置文件路径（#B4，--model-router-file <path>）：读取并 merge 进 config.modelRouter。 */
  modelRouterFile?: string;
  /** 模型重试开关（V2.1，--no-model-retry 关闭；默认开）：429/408/5xx/网络抖动指数退避重试。 */
  modelRetry?: boolean;
  /** 文本流式输出（V2.1，--stream-text）：模型正文 token 级流式打到 stdout，末尾不再重复打印 finalText。 */
  streamText?: boolean;
  /** 回合 token 预算（V2.1，--turn-token-budget N）：累计 usage 超限停止步进，交由总结收尾。 */
  turnTokenBudget?: number;
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

/** 适配器厂商预设（id + baseUrl）。 */
interface AdapterPreset {
  readonly id: string;
  readonly baseUrl: string;
}

/** 按 CLI --model-adapter 反查厂商预设的小表（与 src/server/providerPresets.ts 同源同步）。 */
const ADAPTER_PRESETS: Readonly<Record<string, readonly AdapterPreset[]>> = {
  openai: [
    { id: 'deepseek', baseUrl: 'https://api.deepseek.com' },
    { id: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
    { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'openai', baseUrl: 'https://api.openai.com/v1' },
  ],
  anthropic: [{ id: 'anthropic', baseUrl: 'https://api.anthropic.com' }],
  responses: [{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }],
  llamacpp: [{ id: 'ollama', baseUrl: 'http://localhost:11434/v1' }],
};

/**
 * CLI 参数解析器：原模块级纯函数归拢为 `ArgParser` 方法族，现改为实例方法以消除 `static`；
 * 调用点通过同名门面函数零改动继续引用；`CliDefaults` / `CliArgs` / re-export 保持不变。
 */
export class ArgParser {
  /** 收集非旗标的位置参数（回退为 prompt，如 `omniharness "fix bug"`）。 */
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
   */
  public toWindowsPath(p: string): string {
    let s = p.trim();
    const drive = s.match(/^\/([a-zA-Z])\/(.*)$/);
    if (drive !== null) {
      s = `${drive[1]!.toUpperCase()}:/${drive[2]!}`;
    }
    return s.replace(/\//g, '\\');
  }

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

  /** 配置文件 → CLI 默认参数（仅合并已定义字段）。 */
  public configDefaults(file: FileConfig): Partial<CliArgs> {
    const result: Partial<CliArgs> = {};
    if (file.mcpServers !== undefined) {
      result.mcpServers = file.mcpServers.map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
      }));
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
    // 兜底：当顶层 apiKey/baseUrl 缺失但 providerKeys 已有该厂商凭据时，
    // 按 modelAdapter 枚举所有可能的厂商预设，挑第一个 providerKeys 里有 key 的，
    // 用其 baseUrl/key 补全 apiKey。修复 #OBS-2：「UI 用 providerKeys 模型配的 key，
    // CLI 启动却因缺 apiKey 崩」的 bug。
    if (
      file.modelAdapter !== undefined &&
      (file.apiKey === undefined || file.baseUrl === undefined)
    ) {
      const providerKeys = file.providerKeys ?? {};
      for (const preset of this.adapterPresets(file.modelAdapter)) {
        const presetKey = providerKeys[preset.id];
        if (presetKey !== undefined) {
          if (file.apiKey === undefined) result.apiKey = presetKey;
          if (file.baseUrl === undefined) result.baseUrl = preset.baseUrl;
          break;
        }
      }
    }
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
    if (file.sandbox !== undefined) {
      result.sandbox = file.sandbox;
    }
    if (file.escalation !== undefined) {
      result.escalation = file.escalation;
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
    return result;
  }

  /** 打印用法。 */
  public printUsage(): void {
    process.stdout.write(
      [
        'OmniHarness exec',
        '用法: omniharness exec --prompt "任务" [选项]',
        '      omniharness server [选项]       启动 JSON-RPC stdio 服务',
        '      omniharness serve [选项]        启动 HTTP UI 服务（--port N，--auto-approve 跳过审批弹窗）',
        '      omniharness mcp serve           以 stdio 暴露本地工具集（MCP 服务器，供第三方客户端调用）',
        '      omniharness mcp list --server NAME=CMD   列出外部 MCP 服务器的工具',
        '      omniharness mcp call --server NAME=CMD --tool T [--args JSON]   调用外部 MCP 工具',
        '      omniharness kv get|set|del|list [--key K] [--value V] [--prefix P] [--kv-file PATH]  通用键值存储',
        '      omniharness vault get|set|del|list [--name N] [--value V] [--vault-backend crypto|env] [--vault-key-file PATH]  凭据保险库（AES-256-GCM）',
        '      omniharness profile list|create <name> [--desc D] [--plugin P ...]|delete <name>|use <name>  插件集 Profile（#G-E/P5.1，命名插件组合，一条命令切换编码/研究模式）',
        '      omniharness bundle pack <profileName> [--key-file K] [--out-dir D] | bundle unpack <path.ohb> [--key-file K]  Bundle 发布单元（#G-E 5.2/5.3，可 patch 插件叠层 + 零依赖 zip + 可选 HMAC 签名）',
        '      omniharness native info|ping|tools|approval|session-submit|context|tool-call|bench   进程内直调 Rust 内核（FFI 下沉，需 npm run native:build）',
        '      omniharness goal "<目标描述>" [--goal-max-iterations N]   自主目标循环（#S30，多轮自主推进直到达成或达上限）',
        '      omniharness workflow --file workflow.json   DAG 工作流编排（#S31，多步依赖并发，前序产出注入后续）',
        '      omniharness lsp <definition|references|hover|status> --file PATH --line N --col N [--lsp "server cmd"]   LSP 代码导航（#S32，需自备语言服务器，如 typescript-language-server --stdio）',
        '      omniharness identity <generate|show|sign|verify> [--private-key PKCS8_B64] [--runtime-id ID] [--payload STR] [--signature B64]   Agent 密码学身份（#S33，Ed25519 零依赖；签名/验签会话产物）',
        '      omniharness tui [demo]   零依赖交互式终端 UI（#S35，需 TTY；demo 用回声驱动演示事件流渲染）',
        '选项:',
        '  --version, -V                     打印 API 契约版本（API_VERSION）并退出，不执行',
        '  eval [--suite PATH.json] [--out REPORT.json]   运行评估套件（质量回归基准，默认内置 smoke）',
        '  --model-adapter mock|openai|anthropic|responses|llamacpp   模型端口（默认 mock；responses = OpenAI Responses API 原生通道；llamacpp = 本地 Ollama/llama.cpp 原生 /api/chat）',
        '  --base-url URL  --api-key KEY      OpenAI 兼容端点',
        '  --storage-adapter memory|jsonl    存储端口（默认 jsonl，落盘 ~/.omniharness/sessions）',
        '  --storage-dir DIR                 jsonl 存储目录',
        '  --approval auto|deny|rules|guardian|plan|ask   审批端口（默认 rules：read 放行、rm/del 拒绝、其余按 --approval-ask；plan=只读规划模式仅放行读类工具）',
        '  --approval-ask allow|deny         rules 模式 ask 时裁决（默认 allow）',
        '  --sandbox passthrough|policy|restricted|landlock|seatbelt|bwrap   沙箱多后端（默认 policy=开箱默认拦截危险命令+工作区外路径；restricted=强化策略；passthrough=全放行；OS 级后端本环境 fail-closed）',
        '  --network-allow host1,host2   网络外联白名单（A5；一旦设置即 fail-closed 仅放行所列主机后缀，如 example.com）',
        '  daemon start|stop|status       常驻后台 serve（PID 文件管理，多会话由 serve 承接，D3）',
        '  routines add|list|remove|run   定时任务（interval/cron 调度，D3）',
        '  auth login|callback            企业 SSO（OIDC 授权码流 + PKCE，D2；需真实 IdP 元数据）',
        '  audit export [--compliance]    审计日志导出（json/table/csv）或生成合规报告（含完整性哈希，D2）',
        '  --escalation deny|ask|auto    升级审批（默认 deny=fail-closed 不提权；沙箱拒绝时 ask 交互 / auto 自动提权，危险动作仍 abort）',
        '  --elevated-sandbox passthrough|policy|restricted   提权复核沙箱（默认 policy=fail-closed 收紧：危险命令/工作区外路径仍拦）：escalate 后以此复核放行',
        '  --events console|silent           事件端口（默认 console，进度走 stderr；stdout 仅输出最终答案）',
        '  --compaction-max N                上下文压缩 token 预算（默认 8000）',
        '  --config PATH                     显式配置文件（优先于向上查找 omniharness.json）',
        '  --profile NAME                    配置分层 profile：./profiles/<NAME>.json 或 ~/.omniharness/profiles/<NAME>.json，覆盖项目默认（支持 key 别名与严格校验）',
        '  --plugin-profile NAME             插件集 profile（G-E）：serve/run 启动后把运行时插件集收敛为该命名组合（由 profile.save 创建）',
        '  --spill-adapter memory|file       工具大结果外溢后端（默认 file，落盘 .omniharness/spill）',
        '  --spill-bytes N                   输出超过 N 字节触发外溢（默认 16384）',
        '  --spill-preview N                 外溢后保留的预览字节数（默认 2048）',
        '  --subagent-max-depth N            子智能体最大派生深度（默认 2，即允许 1 层子智能体）',
        '  --subagent-concurrency N          子智能体并发上限（默认 4）',
        '  --subagent-max-steps N            单个子智能体步数上限（默认 12）',
        '  --plan                            计划模式：未批准计划前拦截写类工具（shell/write_file/apply_patch/delegate/subagent）',
        '  --defer-tools LIST                延迟加载工具（逗号分隔），默认不进上下文，需经 tool_search 发现（如 web_search,delegate）',
        '  --tool FILE                       加载自定义工具模块（可重复）',
        '  --workspace DIR                   工作区',
        '  --output FILE                     事件 JSONL 输出文件',
        '  -p, --print                       headless 非交互执行（对标 claude -p / codex exec）：静默过程事件，只输出最终结果；禁交互审批（approval=ask 会挂起 CI，将显式报错）',
        '  --output-format text|json         headless 输出格式：json 输出 {ok,sessionId,steps,finalText} 供 CI 解析（默认 text）',
        '  --resume ID                       续跑历史会话（加载历史后继续）',
        '  --fork ID                         分叉历史会话（复制到新会话）',
        '  --replay ID                       回放历史会话事件（无需 --prompt）',
        '  --mcp-server NAME=COMMAND         桥接外部 MCP 服务器工具（可重复，工具名前缀 NAME__）',
        '  --worker-dsh PROFILE              注册真实 dsh worker（替代演示 worker，需 dsh 已配置）',
        '  --native                          启用 FFI 原生后端：工具执行路由到 Rust 内核 in-process（默认开启；需 npm run native:build；不可用自动回退 TS）',
        '  --dump-config                     仅打印生效配置（含默认值与配置文件合并结果）并退出，不执行',
        '  --auto-commit                     执行后用 git 自动提交变更（Aider 式安全网，需处于 git 仓库）',
        '  --context-window N                上下文窗口 token 数（据此在 75% 处自动压缩，长会话防溢出）',
        '  --auth-required                  开启服务端鉴权门禁（D2，fail-closed：所有 /rpc 与 /ws 调用需有效 Bearer 令牌）',
        '  --oidc-issuer URL --oidc-client-id ID --oidc-jwks-uri URI   门禁用 OIDC 配置（需真实 IdP 的 jwks_uri 端点）',
      ].join('\n') + '\n',
    );
  }

  /** 提取错误消息。 */
  public messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 按 CLI --model-adapter 反查厂商预设（id + baseUrl）。
   * CLI 层独立维护一份小表（与 src/server/providerPresets.ts 同源同步）：
   * openai 适配器对应多家 OpenAI 兼容厂商，按预设默认 baseUrl 命中第一个匹配 providerKey 的。
   */
  public adapterToPreset(adapter: string): AdapterPreset | undefined {
    const list = ADAPTER_PRESETS[adapter];
    return list === undefined || list.length === 0 ? undefined : list[0];
  }

  /** 取适配器下所有可能厂商预设（按 baseUrl 一一对应）。 */
  public adapterPresets(adapter: string): readonly AdapterPreset[] {
    return ADAPTER_PRESETS[adapter] ?? [];
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const argParser = new ArgParser();

/** GitBash / MSYS 路径 → 本机 Windows 路径。 */
export function toWindowsPath(p: string): string {
  return argParser.toWindowsPath(p);
}

/** 解析 CLI 参数（`undefined` 表示 --help 或无任务）。 */
export function parseArgs(argv: readonly string[], defaults?: Partial<CliArgs>): CliArgs | undefined {
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

/** 按适配器反查首个厂商预设。 */
export function adapterToPreset(adapter: string): AdapterPreset | undefined {
  return argParser.adapterToPreset(adapter);
}

/** 取适配器下所有厂商预设。 */
export function adapterPresets(adapter: string): readonly AdapterPreset[] {
  return argParser.adapterPresets(adapter);
}
