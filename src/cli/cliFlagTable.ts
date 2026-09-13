import type { CliArgs } from './argParser.js';
import { parseMcpServerSpec } from '../mcp/mcpServerCommand.js';
import type { ModelRouterConfig } from '../config/configFile.js';
import {
  MODEL_ADAPTERS,
  STORAGE_ADAPTERS,
  APPROVALS,
  APPROVAL_ASKS,
  SANDBOX_PROFILES,
  ESCALATIONS,
  ELEVATED_SANDBOXES,
  EVENT_PORTS,
  SPILL_ADAPTERS,
  OUTPUT_FORMATS,
  KV_ADAPTERS,
} from './cliEnums.js';

/** 消费值的长选项集合（用于位置参数识别：其紧跟的值不视为 prompt）。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--config',
  '--profile',
  '--model-adapter',
  '--base-url',
  '--api-key',
  '--model',
  '--storage-adapter',
  '--storage-dir',
  '--approval',
  '--approval-ask',
  '--sandbox',
  '--escalation',
  '--elevated-sandbox',
  '--compaction-max',
  '--spill-adapter',
  '--spill-bytes',
  '--spill-preview',
  '--defer-tools',
  '--lsp',
  '--subagent-max-depth',
  '--subagent-concurrency',
  '--subagent-max-steps',
  '--tool',
  '--workspace',
  '--output',
  '--resume',
  '--fork',
  '--replay',
  '--prompt',
  '--mcp-server',
  '--worker-dsh',
  '--plugin-profile',
  '--memory-encrypt',
  '--memory-key-file',
  '--context-window',
  '--output-format',
  '--model-router',
  '--model-router-file',
  '--turn-token-budget',
  '--vault-hydrate-names',
  '--vault-key-file',
  '--kv-adapter',
  '--kv-file',
  '--oidc-issuer',
  '--oidc-client-id',
  '--oidc-jwks-uri',
]);

/** 取下一个参数值。 */
function valueOf(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`缺少参数值: ${flag}`);
  }
  return value;
}

/**
 * 校验枚举值属于白名单，非法即抛错（fail-closed）。
 *
 * 与 `valueOf` 同为抛错风格：错误由 `ExecCli.run()` 的 catch 统一以非零码退出，
 * 绝不静默回落到默认值——回落会让「拼错的安全参数」变成「配置未生效」的假绿。
 */
export function checkEnum<T extends string>(value: string, flag: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`非法参数值: ${flag} = ${value}（可选: ${allowed.join(' | ')}）`);
  }
  return value as T;
}

/** 取下一个参数值并校验枚举白名单。 */
function enumOf<T extends string>(
  argv: readonly string[],
  index: number,
  flag: string,
  allowed: readonly T[],
): T {
  return checkEnum(valueOf(argv, index, flag), flag, allowed);
}

/**
 * 手写参数解析（零依赖；defaults 来自配置文件，CLI 参数优先）。
 * 各 flag 的处理收归到 FLAG_TABLE，使本函数保持短小（禁大函数铁律）；
 * 每个 flag 的处理闭包自行负责取值与类型化赋值，互不耦合。
 */
type FlagApply = (args: CliArgs, argv: readonly string[], i: number) => number;

const FLAG_TABLE: Record<string, FlagApply> = {
  '--model-adapter': (a, argv, i) => {
    a.modelAdapter = enumOf(argv, i, '--model-adapter', MODEL_ADAPTERS);
    return 1;
  },
  '--base-url': (a, argv, i) => {
    a.baseUrl = valueOf(argv, i, '--base-url');
    return 1;
  },
  '--api-key': (a, argv, i) => {
    a.apiKey = valueOf(argv, i, '--api-key');
    return 1;
  },
  '--network-allow': (a, argv, i) => {
    a.networkAllow = valueOf(argv, i, '--network-allow');
    return 1;
  },
  '--model': (a, argv, i) => {
    a.model = valueOf(argv, i, '--model');
    return 1;
  },
  '--storage-adapter': (a, argv, i) => {
    a.storageAdapter = enumOf(argv, i, '--storage-adapter', STORAGE_ADAPTERS);
    return 1;
  },
  '--storage-dir': (a, argv, i) => {
    a.storageDir = valueOf(argv, i, '--storage-dir');
    return 1;
  },
  '--approval': (a, argv, i) => {
    a.approval = enumOf(argv, i, '--approval', APPROVALS);
    return 1;
  },
  '--approval-ask': (a, argv, i) => {
    a.approvalAsk = enumOf(argv, i, '--approval-ask', APPROVAL_ASKS);
    return 1;
  },
  '--sandbox': (a, argv, i) => {
    a.sandbox = enumOf(argv, i, '--sandbox', SANDBOX_PROFILES);
    return 1;
  },
  '--escalation': (a, argv, i) => {
    a.escalation = enumOf(argv, i, '--escalation', ESCALATIONS);
    return 1;
  },
  '--elevated-sandbox': (a, argv, i) => {
    a.elevatedSandbox = enumOf(argv, i, '--elevated-sandbox', ELEVATED_SANDBOXES);
    return 1;
  },
  '--compaction-max': (a, argv, i) => {
    a.compactionMax = Number.parseInt(valueOf(argv, i, '--compaction-max'), 10);
    return 1;
  },
  '--memory-encrypt': (a) => {
    a.memoryEncrypt = true;
    return 0;
  },
  '--guard-prompt-injection': (a) => {
    a.promptInjectionGuard = true;
    return 0;
  },
  '--memory-key-file': (a, argv, i) => {
    a.memoryKeyFile = valueOf(argv, i, '--memory-key-file');
    return 1;
  },
  '--spill-adapter': (a, argv, i) => {
    a.spillAdapter = enumOf(argv, i, '--spill-adapter', SPILL_ADAPTERS);
    return 1;
  },
  '--spill-bytes': (a, argv, i) => {
    a.spillMax = Number.parseInt(valueOf(argv, i, '--spill-bytes'), 10);
    return 1;
  },
  '--spill-preview': (a, argv, i) => {
    a.spillPreview = Number.parseInt(valueOf(argv, i, '--spill-preview'), 10);
    return 1;
  },
  '--plan': (a) => {
    a.planMode = true;
    return 0;
  },
  '--defer-tools': (a, argv, i) => {
    a.deferTools = valueOf(argv, i, '--defer-tools');
    return 1;
  },
  '--lsp': (a, argv, i) => {
    a.lsp = valueOf(argv, i, '--lsp');
    return 1;
  },
  '--subagent-max-depth': (a, argv, i) => {
    a.subagentMaxDepth = Number.parseInt(valueOf(argv, i, '--subagent-max-depth'), 10);
    return 1;
  },
  '--subagent-concurrency': (a, argv, i) => {
    a.subagentConcurrency = Number.parseInt(valueOf(argv, i, '--subagent-concurrency'), 10);
    return 1;
  },
  '--subagent-max-steps': (a, argv, i) => {
    a.subagentMaxSteps = Number.parseInt(valueOf(argv, i, '--subagent-max-steps'), 10);
    return 1;
  },
  '--events': (a, argv, i) => {
    a.events = enumOf(argv, i, '--events', EVENT_PORTS);
    return 1;
  },
  '--tool': (a, argv, i) => {
    a.toolFiles = [...a.toolFiles, valueOf(argv, i, '--tool')];
    return 1;
  },
  '--workspace': (a, argv, i) => {
    a.workspace = valueOf(argv, i, '--workspace');
    return 1;
  },
  '--output': (a, argv, i) => {
    a.output = valueOf(argv, i, '--output');
    return 1;
  },
  '--resume': (a, argv, i) => {
    a.resumeId = valueOf(argv, i, '--resume');
    return 1;
  },
  '--fork': (a, argv, i) => {
    a.forkId = valueOf(argv, i, '--fork');
    return 1;
  },
  '--replay': (a, argv, i) => {
    a.replayId = valueOf(argv, i, '--replay');
    return 1;
  },
  '--prompt': (a, argv, i) => {
    a.prompt = valueOf(argv, i, '--prompt');
    return 1;
  },
  '--mcp-server': (a, argv, i) => {
    a.mcpServers = [...a.mcpServers, parseMcpServerSpec(valueOf(argv, i, '--mcp-server'))];
    return 1;
  },
  '--worker-dsh': (a, argv, i) => {
    a.workerDsh = valueOf(argv, i, '--worker-dsh');
    return 1;
  },
  '--native': (a) => {
    a.native = true;
    return 0;
  },
  '--dump-config': (a) => {
    a.dumpConfig = true;
    return 0;
  },
  '--auto-commit': (a) => {
    a.autoCommit = true;
    return 0;
  },
  /** headless 模式（对标 `claude -p` / `codex exec`）：非交互单次执行，供 CI 消费。 */
  '--print': (a) => {
    a.print = true;
    a.events = 'silent';
    return 0;
  },
  '-p': (a) => {
    a.print = true;
    a.events = 'silent';
    return 0;
  },
  '--output-format': (a, argv, i) => {
    const raw = valueOf(argv, i, '--output-format');
    if (!OUTPUT_FORMATS.includes(raw as (typeof OUTPUT_FORMATS)[number])) {
      throw new Error(`--output-format 非法值: ${raw}（可选: ${OUTPUT_FORMATS.join(' | ')}）`);
    }
    a.outputFormat = raw as (typeof OUTPUT_FORMATS)[number];
    return 1;
  },
  '--context-window': (a, argv, i) => {
    a.contextWindow = Number.parseInt(valueOf(argv, i, '--context-window'), 10);
    return 1;
  },
  '--plugin-profile': (a, argv, i) => {
    a.pluginProfile = valueOf(argv, i, '--plugin-profile');
    return 1;
  },
  '--model-router': (a, argv, i) => {
    a.modelRouter = JSON.parse(valueOf(argv, i, '--model-router')) as ModelRouterConfig;
    return 1;
  },
  '--model-router-file': (a, argv, i) => {
    a.modelRouterFile = valueOf(argv, i, '--model-router-file');
    return 1;
  },
  // V2.1 循环质量三旗标：重试默认开（--no-model-retry 显式关）、文本流式、回合 token 预算。
  '--no-model-retry': (a) => {
    a.modelRetry = false;
    return 0;
  },
  // F3 模型熔断：与重试同口径默认开，--no- 显式关闭（下游持续不可用时短路，冷却后自动半开）。
  '--no-model-circuit-breaker': (a) => {
    a.modelCircuitBreaker = false;
    return 0;
  },
  '--model-circuit-breaker-threshold': (a, argv, i) => {
    a.modelCircuitBreakerThreshold = Number.parseInt(
      valueOf(argv, i, '--model-circuit-breaker-threshold'),
      10,
    );
    return 1;
  },
  '--model-circuit-breaker-open-ms': (a, argv, i) => {
    a.modelCircuitBreakerOpenMs = Number.parseInt(
      valueOf(argv, i, '--model-circuit-breaker-open-ms'),
      10,
    );
    return 1;
  },
  '--stream-text': (a) => {
    a.streamText = true;
    return 0;
  },
  // F3 凭据水合：默认关。开启后装配期把加密保险库凭据水合进进程环境（仅填充未设置项），
  // 让模型适配器/路由无需改动即获得「env 优先、保险库回退」的第二凭据源。
  '--vault-hydrate': (a) => {
    a.vaultHydrate = true;
    return 0;
  },
  '--vault-hydrate-names': (a, argv, i) => {
    a.vaultHydrateNames = valueOf(argv, i, '--vault-hydrate-names')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return 1;
  },
  '--vault-key-file': (a, argv, i) => {
    a.vaultKeyFile = valueOf(argv, i, '--vault-key-file');
    return 1;
  },
  '--kv-adapter': (a, argv, i) => {
    a.kvAdapter = enumOf(argv, i, '--kv-adapter', KV_ADAPTERS);
    return 1;
  },
  '--kv-file': (a, argv, i) => {
    a.kvFile = valueOf(argv, i, '--kv-file');
    return 1;
  },
  '--turn-token-budget': (a, argv, i) => {
    a.turnTokenBudget = Number.parseInt(valueOf(argv, i, '--turn-token-budget'), 10);
    return 1;
  },
  // D2 服务端鉴权门禁的 OIDC 配置（仅 serve 消费，不进入 CliArgs 通用字段）。
  '--oidc-issuer': () => 1,
  '--oidc-client-id': () => 1,
  '--oidc-jwks-uri': () => 1,
};

export { VALUE_FLAGS, FLAG_TABLE };
