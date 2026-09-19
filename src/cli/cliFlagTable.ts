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
  A2A_TRANSPORTS,
  BUDGET_ON_EXCEED,
} from './cliEnums.js';

/**
 * CliFlagTable 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class CliFlagTable {
  /**
   * 取下一个参数值。
   * @param argv readonly string[]
   * @param index number
   * @param flag string
   * @returns string
   */
  public static valueOf(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`缺少参数值: ${flag}`);
    }
    return value;
  }
  /**
   * 取下一个参数值并校验枚举白名单。
   * @param argv readonly string[]
   * @param index number
   * @param flag string
   * @param allowed readonly T[]
   * @returns T
   */
  public static enumOf<T extends string>(
    argv: readonly string[],
    index: number,
    flag: string,
    allowed: readonly T[],
  ): T {
    return checkEnum(CliFlagTable.valueOf(argv, index, flag), flag, allowed);
  }
}

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
  // (P5) 成本预算三旗标（取值 → 必须登记，否则取值会被 collectPositional 并入 prompt）。
  '--cost-budget-usd',
  '--cost-budget-on-exceed',
  '--cost-budget-soft-ratio',
  '--vault-hydrate-names',
  '--vault-key-file',
  '--kv-adapter',
  '--kv-file',
  '--oidc-issuer',
  '--oidc-client-id',
  '--oidc-jwks-uri',
  // (E2 顺带修) E3 新增的 RLVR 取值旗标此前漏登记 → `collectPositional` 会把它们的取值
  // 误判为位置参数（prompt），此处补齐；并由 `cliFlagValueRegistry.test.ts` 机器兜底。
  '--rlvr-verify',
  '--rlvr-samples',
  '--rlvr-min-reward',
  '--rlvr-candidates',
  '--rlvr-min-gain',
  '--a2a-port',
  '--a2a-peer',
  '--a2a-transport',
  // 以下 4 项由 `cliFlagValueRegistry.test.ts` 护栏抓出（同为历史漏登记，取值会被并入 prompt）。
  '--network-allow',
  '--events',
  '--model-circuit-breaker-threshold',
  '--model-circuit-breaker-open-ms',
]);

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

/**
 * 手写参数解析（零依赖；defaults 来自配置文件，CLI 参数优先）。
 * 各 flag 的处理收归到 FLAG_TABLE，使本函数保持短小（禁大函数铁律）；
 * 每个 flag 的处理闭包自行负责取值与类型化赋值，互不耦合。
 */
type FlagApply = (args: CliArgs, argv: readonly string[], i: number) => number;

const FLAG_TABLE: Record<string, FlagApply> = {
  '--model-adapter': (a, argv, i) => {
    a.modelAdapter = CliFlagTable.enumOf(argv, i, '--model-adapter', MODEL_ADAPTERS);
    return 1;
  },
  '--base-url': (a, argv, i) => {
    a.baseUrl = CliFlagTable.valueOf(argv, i, '--base-url');
    return 1;
  },
  '--api-key': (a, argv, i) => {
    a.apiKey = CliFlagTable.valueOf(argv, i, '--api-key');
    return 1;
  },
  '--network-allow': (a, argv, i) => {
    a.networkAllow = CliFlagTable.valueOf(argv, i, '--network-allow');
    return 1;
  },
  '--model': (a, argv, i) => {
    a.model = CliFlagTable.valueOf(argv, i, '--model');
    return 1;
  },
  '--storage-adapter': (a, argv, i) => {
    a.storageAdapter = CliFlagTable.enumOf(argv, i, '--storage-adapter', STORAGE_ADAPTERS);
    return 1;
  },
  '--storage-dir': (a, argv, i) => {
    a.storageDir = CliFlagTable.valueOf(argv, i, '--storage-dir');
    return 1;
  },
  '--approval': (a, argv, i) => {
    a.approval = CliFlagTable.enumOf(argv, i, '--approval', APPROVALS);
    return 1;
  },
  '--approval-ask': (a, argv, i) => {
    a.approvalAsk = CliFlagTable.enumOf(argv, i, '--approval-ask', APPROVAL_ASKS);
    return 1;
  },
  '--sandbox': (a, argv, i) => {
    a.sandbox = CliFlagTable.enumOf(argv, i, '--sandbox', SANDBOX_PROFILES);
    return 1;
  },
  '--escalation': (a, argv, i) => {
    a.escalation = CliFlagTable.enumOf(argv, i, '--escalation', ESCALATIONS);
    return 1;
  },
  '--elevated-sandbox': (a, argv, i) => {
    a.elevatedSandbox = CliFlagTable.enumOf(argv, i, '--elevated-sandbox', ELEVATED_SANDBOXES);
    return 1;
  },
  '--compaction-max': (a, argv, i) => {
    a.compactionMax = Number.parseInt(CliFlagTable.valueOf(argv, i, '--compaction-max'), 10);
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
  '--self-verify': (a) => {
    a.selfVerify = true;
    return 0;
  },
  // 自验证自 P1-⑨ 起**默认开启**（生产入口），故需要一个显式关闭开关；
  // 两者都写同一个三态字段（undefined=默认开 / true=开 / false=关）。
  '--no-self-verify': (a) => {
    a.selfVerify = false;
    return 0;
  },
  '--memory-key-file': (a, argv, i) => {
    a.memoryKeyFile = CliFlagTable.valueOf(argv, i, '--memory-key-file');
    return 1;
  },
  '--spill-adapter': (a, argv, i) => {
    a.spillAdapter = CliFlagTable.enumOf(argv, i, '--spill-adapter', SPILL_ADAPTERS);
    return 1;
  },
  '--spill-bytes': (a, argv, i) => {
    a.spillMax = Number.parseInt(CliFlagTable.valueOf(argv, i, '--spill-bytes'), 10);
    return 1;
  },
  '--spill-preview': (a, argv, i) => {
    a.spillPreview = Number.parseInt(CliFlagTable.valueOf(argv, i, '--spill-preview'), 10);
    return 1;
  },
  '--plan': (a) => {
    a.planMode = true;
    return 0;
  },
  '--defer-tools': (a, argv, i) => {
    a.deferTools = CliFlagTable.valueOf(argv, i, '--defer-tools');
    return 1;
  },
  '--lsp': (a, argv, i) => {
    a.lsp = CliFlagTable.valueOf(argv, i, '--lsp');
    return 1;
  },
  '--subagent-max-depth': (a, argv, i) => {
    a.subagentMaxDepth = Number.parseInt(CliFlagTable.valueOf(argv, i, '--subagent-max-depth'), 10);
    return 1;
  },
  '--subagent-concurrency': (a, argv, i) => {
    a.subagentConcurrency = Number.parseInt(
      CliFlagTable.valueOf(argv, i, '--subagent-concurrency'),
      10,
    );
    return 1;
  },
  '--subagent-max-steps': (a, argv, i) => {
    a.subagentMaxSteps = Number.parseInt(CliFlagTable.valueOf(argv, i, '--subagent-max-steps'), 10);
    return 1;
  },
  '--events': (a, argv, i) => {
    a.events = CliFlagTable.enumOf(argv, i, '--events', EVENT_PORTS);
    return 1;
  },
  '--tool': (a, argv, i) => {
    a.toolFiles = [...a.toolFiles, CliFlagTable.valueOf(argv, i, '--tool')];
    return 1;
  },
  '--workspace': (a, argv, i) => {
    a.workspace = CliFlagTable.valueOf(argv, i, '--workspace');
    return 1;
  },
  '--output': (a, argv, i) => {
    a.output = CliFlagTable.valueOf(argv, i, '--output');
    return 1;
  },
  '--resume': (a, argv, i) => {
    a.resumeId = CliFlagTable.valueOf(argv, i, '--resume');
    return 1;
  },
  '--fork': (a, argv, i) => {
    a.forkId = CliFlagTable.valueOf(argv, i, '--fork');
    return 1;
  },
  '--replay': (a, argv, i) => {
    a.replayId = CliFlagTable.valueOf(argv, i, '--replay');
    return 1;
  },
  '--prompt': (a, argv, i) => {
    a.prompt = CliFlagTable.valueOf(argv, i, '--prompt');
    return 1;
  },
  '--mcp-server': (a, argv, i) => {
    a.mcpServers = [
      ...a.mcpServers,
      parseMcpServerSpec(CliFlagTable.valueOf(argv, i, '--mcp-server')),
    ];
    return 1;
  },
  '--worker-dsh': (a, argv, i) => {
    a.workerDsh = CliFlagTable.valueOf(argv, i, '--worker-dsh');
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
    const raw = CliFlagTable.valueOf(argv, i, '--output-format');
    if (!OUTPUT_FORMATS.includes(raw as (typeof OUTPUT_FORMATS)[number])) {
      throw new Error(`--output-format 非法值: ${raw}（可选: ${OUTPUT_FORMATS.join(' | ')}）`);
    }
    a.outputFormat = raw as (typeof OUTPUT_FORMATS)[number];
    return 1;
  },
  '--context-window': (a, argv, i) => {
    a.contextWindow = Number.parseInt(CliFlagTable.valueOf(argv, i, '--context-window'), 10);
    return 1;
  },
  '--plugin-profile': (a, argv, i) => {
    a.pluginProfile = CliFlagTable.valueOf(argv, i, '--plugin-profile');
    return 1;
  },
  '--model-router': (a, argv, i) => {
    a.modelRouter = JSON.parse(
      CliFlagTable.valueOf(argv, i, '--model-router'),
    ) as ModelRouterConfig;
    return 1;
  },
  '--model-router-file': (a, argv, i) => {
    a.modelRouterFile = CliFlagTable.valueOf(argv, i, '--model-router-file');
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
      CliFlagTable.valueOf(argv, i, '--model-circuit-breaker-threshold'),
      10,
    );
    return 1;
  },
  '--model-circuit-breaker-open-ms': (a, argv, i) => {
    a.modelCircuitBreakerOpenMs = Number.parseInt(
      CliFlagTable.valueOf(argv, i, '--model-circuit-breaker-open-ms'),
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
    a.vaultHydrateNames = CliFlagTable.valueOf(argv, i, '--vault-hydrate-names')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return 1;
  },
  '--vault-key-file': (a, argv, i) => {
    a.vaultKeyFile = CliFlagTable.valueOf(argv, i, '--vault-key-file');
    return 1;
  },
  '--kv-adapter': (a, argv, i) => {
    a.kvAdapter = CliFlagTable.enumOf(argv, i, '--kv-adapter', KV_ADAPTERS);
    return 1;
  },
  '--kv-file': (a, argv, i) => {
    a.kvFile = CliFlagTable.valueOf(argv, i, '--kv-file');
    return 1;
  },
  // (U4) RLVR 进化闭环：默认关。开启后装配期构造「可验证门禁 + RLVR sample-filter-replay」控制器；
  // 验证命令含 %CODE_FILE% 时先把候选代码写入临时文件再跑（真实编译/测试绿度即奖励信号）。
  '--a2a': (a) => {
    a.a2a = true;
    return 0;
  },
  '--a2a-port': (a, argv, i) => {
    a.a2aPort = Number.parseInt(CliFlagTable.valueOf(argv, i, '--a2a-port'), 10);
    return 1;
  },
  '--a2a-peer': (a, argv, i) => {
    a.a2aPeer = CliFlagTable.valueOf(argv, i, '--a2a-peer');
    return 1;
  },
  '--a2a-transport': (a, argv, i) => {
    a.a2aTransport = CliFlagTable.enumOf(argv, i, '--a2a-transport', A2A_TRANSPORTS);
    return 1;
  },
  '--evolution-rlvr': (a) => {
    a.evolutionRlvr = true;
    return 0;
  },
  '--rlvr-verify': (a, argv, i) => {
    a.rlvrVerify = CliFlagTable.valueOf(argv, i, '--rlvr-verify');
    return 1;
  },
  '--rlvr-samples': (a, argv, i) => {
    a.rlvrSamples = Number.parseInt(CliFlagTable.valueOf(argv, i, '--rlvr-samples'), 10);
    return 1;
  },
  '--rlvr-min-reward': (a, argv, i) => {
    a.rlvrMinReward = Number.parseFloat(CliFlagTable.valueOf(argv, i, '--rlvr-min-reward'));
    return 1;
  },
  '--rlvr-candidates': (a, argv, i) => {
    a.rlvrCandidates = Number.parseInt(CliFlagTable.valueOf(argv, i, '--rlvr-candidates'), 10);
    return 1;
  },
  '--rlvr-min-gain': (a, argv, i) => {
    a.rlvrMinGain = Number.parseFloat(CliFlagTable.valueOf(argv, i, '--rlvr-min-gain'));
    return 1;
  },
  '--rlvr-auto-run': (a) => {
    a.rlvrAutoRun = true;
    return 0;
  },
  '--turn-token-budget': (a, argv, i) => {
    a.turnTokenBudget = Number.parseInt(CliFlagTable.valueOf(argv, i, '--turn-token-budget'), 10);
    return 1;
  },
  // (P5) 成本预算：USD 上限 / 耗尽行为 / 软阈值比例。
  '--cost-budget-usd': (a, argv, i) => {
    a.costBudgetUsd = Number.parseFloat(CliFlagTable.valueOf(argv, i, '--cost-budget-usd'));
    return 1;
  },
  '--cost-budget-on-exceed': (a, argv, i) => {
    a.costBudgetOnExceed = CliFlagTable.enumOf(
      argv,
      i,
      '--cost-budget-on-exceed',
      BUDGET_ON_EXCEED,
    );
    return 1;
  },
  '--cost-budget-soft-ratio': (a, argv, i) => {
    a.costBudgetSoftRatio = Number.parseFloat(
      CliFlagTable.valueOf(argv, i, '--cost-budget-soft-ratio'),
    );
    return 1;
  },
  // D2 服务端鉴权门禁的 OIDC 配置（仅 serve 消费，不进入 CliArgs 通用字段）。
  '--oidc-issuer': () => 1,
  '--oidc-client-id': () => 1,
  '--oidc-jwks-uri': () => 1,
};

export { VALUE_FLAGS, FLAG_TABLE };
