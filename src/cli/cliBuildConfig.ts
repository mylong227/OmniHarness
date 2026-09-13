/**
 * cliBuildConfig.ts —— ExecCli 的配置装配簇（god-class 拆分 · 第 1/6 层）。
 *
 * 这是命令类继承链的根基类，承载所有「共享接线 / 配置装配」辅助方法：
 * 参数取用（flagValue / flagNumber / collectFlags）、LSP/JSON 解析（parseLsp / parseJsonObject）、
 * 注册表/审计 sink 构造（createRegistry / createAudit）、网络门禁（applyNetworkGuard）、
 * 以及 buildConfig 与其全部 build* 助手（模型 / 存储 / 审批 / 沙箱 / 升级 / MCP 桥接 / 自定义工具）。
 *
 * 拆分原则：方法体逐字节等价于原 exec.ts，仅把 `private` 改为 `protected`（供子类 dispatch 调用）。
 * 所有 `this.` 调用指向本类或祖先的成员，绝不依赖任何尚未存在的符号。
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { NativeKernel } from '../native/nativeKernel.js';
import { ConfigFactory } from '../config/configFactory.js';
import type { ResolvedConfig } from '../config/configFactory.js';
import type { ExtraTool } from '../config/configFactory.js';
import { ConsoleEventPort } from '../adapters/event/consoleEventPort.js';
import { SilentEventPort } from '../adapters/event/silentEventPort.js';
import { ConsoleLiveView } from '../adapters/live/consoleLiveView.js';
import { PluginRegistry } from '../plugin/pluginRegistry.js';
import { AuditSink } from '../server/services/auditSink.js';
import { NetworkEgressGuard, parseAllowList } from '../adapters/sandbox/networkEgressGuard.js';
import { WorkerRegistry } from '../worker/workerRegistry.js';
import { dshWorker } from '../worker/dshWorker.js';
import { RegistryToolPort } from '../adapters/tool/registryToolPort.js';
import { McpGateway } from '../mcp/mcpGateway.js';
import { formatBridgeResults } from '../mcp/mcpServerCommand.js';
import { MockModel } from '../adapters/model/mockModel.js';
import { OpenAiCompatibleModel } from '../adapters/model/openAiCompatibleModel.js';
import { AnthropicModel } from '../adapters/model/anthropicModel.js';
import { ResponsesModel } from '../adapters/model/responsesModel.js';
import { LlamaCppModel } from '../adapters/model/llamaCppModel.js';
import { MemoryStorage } from '../adapters/storage/memoryStorage.js';
import { JsonlStorage } from '../adapters/storage/jsonlStorage.js';
import type { SqliteStorage } from '../adapters/storage/sqliteStorage.js';
import { AutoApproval } from '../adapters/approval/autoApproval.js';
import { DenyApproval } from '../adapters/approval/denyApproval.js';
import { RuleApproval } from '../adapters/approval/ruleApproval.js';
import { GuardianApproval } from '../adapters/approval/guardianApproval.js';
import { PlanApproval } from '../adapters/approval/planApproval.js';
import type { ApprovalRule } from '../adapters/approval/approvalRule.js';
import { dangerousCommands } from '../adapters/sandbox/dangerousCommands.js';
import { SandboxManager } from '../adapters/sandbox/sandboxManager.js';
import { DenyEscalation } from '../adapters/escalation/denyEscalation.js';
import { AskEscalation } from '../adapters/escalation/askEscalation.js';
import { AutoEscalation } from '../adapters/escalation/autoEscalation.js';
import type { EscalationRequest, EscalationDecision } from '../ports/runtime/escalation.js';
import type { ModelPort } from '../ports/model/model.js';
import type { ModelRouterConfig } from '../config/configFile.js';
import type { LspServerConfig } from '../ports/tool/lsp.js';
import { loadToolModule } from './toolLoader.js';
import { CliArgReader } from './cliArgReader.js';
import { KvStoreFactory } from './kvStoreFactory.js';
import { CredentialResolver } from '../config/credentialResolver.js';
import { CryptoVault } from '../adapters/vault/cryptoVault.js';
import type { CliArgs } from './argParser.js';

/**
 * F3 凭据水合的内置默认名列表。
 *
 * 取值即「模型适配器在缺 `--api-key` 时读取的环境变量」（见 {@link CliBuildConfig.buildModel}
 * 与 `ConfigBuilder.buildRouter`），因此水合这几个名字即可让整个生产凭据链获得保险库回退源。
 */
const DEFAULT_CREDENTIAL_NAMES: readonly string[] = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

/**
 * 凭据水合所需的参数子集（窄接口）。
 *
 * 只声明水合真正读的字段，不依赖整个 {@link CliArgs}：既让 `CliArgs` 可直接传入（结构兼容），
 * 也让调用点与单测无需伪造二十余个必填字段。
 */
export interface CredentialHydrationArgs {
  /** 是否开启水合（**缺省关** = 零行为变更）。 */
  readonly vaultHydrate?: boolean | undefined;
  /** 要水合的凭据名；省略时用内置默认名列表。 */
  readonly vaultHydrateNames?: readonly string[] | undefined;
  /** 保险库主密钥文件（主密钥优先取环境变量 `OMNIHARNESS_VAULT_KEY`）。 */
  readonly vaultKeyFile?: string | undefined;
  /** 密文 KV 后端（默认 json-file，与 `vault` 子命令同一默认）。 */
  readonly kvAdapter?: 'memory' | 'json-file' | 'sqlite' | undefined;
  /** 密文 KV 落盘路径。 */
  readonly kvFile?: string | undefined;
}

/** ExecCli 继承链根基类：共享接线与配置装配。 */
export class CliBuildConfig {
  /** 当前活动的 MCP 网关（执行结束后由子类 closeGateway 关闭子进程）。 */
  protected gateway: McpGateway | undefined;

  /**
   * 取标志值（委托 CliArgReader，保证解析逻辑单一来源）。
   * @param args 完整命令行参数列表。
   * @param flag 旗标名（如 `--model`）。
   * @returns 紧随旗标之后的值；旗标不存在或其后无值时返回 undefined。
   */
  protected flagValue(args: readonly string[], flag: string): string | undefined {
    return new CliArgReader(args).value(flag);
  }

  /**
   * 取数字标志值（委托 CliArgReader）。
   * @param args 完整命令行参数列表。
   * @param flag 旗标名（如 `--max-steps`）。
   * @returns 解析后的十进制整数；旗标缺失返回 undefined（值非法时为 NaN，与既有行为一致）。
   */
  protected flagNumber(args: readonly string[], flag: string): number | undefined {
    return new CliArgReader(args).number(flag);
  }

  /**
   * 收集可重复旗标的所有取值（如 --allow a --allow b；委托 CliArgReader）。
   * @param args 完整命令行参数列表。
   * @param flag 可重复出现的旗标名。
   * @returns 该旗标的全部取值（按出现顺序，可能为空数组）。
   */
  protected collectFlags(args: readonly string[], flag: string): string[] {
    return new CliArgReader(args).values(flag);
  }

  /**
   * 解析 --lsp "server cmd args" 为 LSP 服务器配置（命令 + 参数）。
   * @param raw 旗标原始取值（空白分隔的命令与参数）；undefined 或全空白视为未配置。
   * @returns LSP 服务器配置（首个 token 为命令，其余为参数）；未配置时返回 undefined。
   */
  protected parseLsp(raw: string | undefined): LspServerConfig | undefined {
    if (raw === undefined || raw.trim() === '') {
      return undefined;
    }
    const parts = raw.trim().split(/\s+/);
    const serverCommand = parts[0] ?? '';
    const serverArgs = parts.slice(1);
    return { serverCommand, serverArgs };
  }

  /**
   * 解析 JSON 对象参数（缺省空对象）。
   * @param raw JSON 文本；undefined 或全空白视为空对象。
   * @returns 解析出的对象；文本非法 JSON 时抛 SyntaxError。
   */
  protected parseJsonObject(raw: string | undefined): Record<string, unknown> {
    if (raw === undefined || raw.trim() === '') {
      return {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /**
   * 构造插件注册表：--dir 覆盖安装目录，打包源基准为仓库根。
   * @param args 完整命令行参数列表（读取 --dir / --catalog）。
   * @param pluginsDir 显式指定的插件安装目录；缺省时依次回退 --dir 旗标、~/.omniharness/plugins。
   * @returns 就绪的插件注册表（catalog 指向仓库内 examples/catalog/registry.json）。
   */
  protected createRegistry(args: readonly string[], pluginsDir?: string): PluginRegistry {
    const dir =
      pluginsDir ?? this.flagValue(args, '--dir') ?? join(homedir(), '.omniharness', 'plugins');
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    // 离线 catalog 占位 registry：仓库内 examples/catalog/registry.json，
    // 作为真实 registry 占位服务，离线可用、可被用户编辑以扩展市场。
    const catalog =
      this.flagValue(args, '--catalog') ?? join(repoRoot, 'examples', 'catalog', 'registry.json');
    return new PluginRegistry({
      pluginsDir: dir,
      bundledBaseDir: repoRoot,
      registryFile: catalog,
      registryBaseDir: repoRoot,
    });
  }

  /**
   * 构造审计 sink：--audit-dir / --audit-file 或 env OMNI_AUDIT_DIR 指定落盘位置；未指定则 no-op（不写审计）。
   * @param args 完整命令行参数列表（读取 --audit-dir / --audit-file）。
   * @returns 审计 sink；--audit-file 优先于目录级配置。
   */
  protected createAudit(args: readonly string[]): AuditSink {
    const auditDir = this.flagValue(args, '--audit-dir') ?? process.env['OMNI_AUDIT_DIR'];
    const auditFile = this.flagValue(args, '--audit-file');
    return new AuditSink(
      auditFile !== undefined
        ? { path: auditFile }
        : auditDir !== undefined
          ? { dir: auditDir }
          : {},
    );
  }

  /**
   * 若配置了 --network-allow，安装网络外联策略门（A5）：包一层 globalThis.fetch，
   * 任何不在白名单的外联地址一律抛 EgressBlockedError（fail-closed）。返回还原函数。
   * 未配置白名单时返回空操作（开放，不收紧）。
   * @param args 解析后的 CLI 参数（读取 networkAllow 白名单）。
   * @returns 还原函数（恢复原始 globalThis.fetch）；未配置白名单时为空操作。
   */
  protected applyNetworkGuard(args: CliArgs): () => void {
    const allowed = parseAllowList(args.networkAllow);
    if (allowed.length === 0) {
      return () => {};
    }
    const guard = new NetworkEgressGuard({ allowedHosts: allowed });
    const original = globalThis.fetch;
    globalThis.fetch = guard.wrapFetch(original);
    process.stderr.write(`[omniharness] 网络外联策略已启用，仅放行: ${allowed.join(', ')}\n`);
    return () => {
      globalThis.fetch = original;
    };
  }

  /**
   * F3 凭据水合：把加密保险库中的凭据接进生产凭据链。
   *
   * 背景：`VaultPort`（CryptoVault）此前只被 `vault` 子命令使用，而模型适配器与模型路由
   * 都硬读 `process.env`——保险库里存的凭据在生产路径上无人读取。本方法补上这段接线：
   * **环境变量优先、保险库回退**（仅填充未设置项，绝不覆盖显式配置）。
   *
   * 缺省（未开 `--vault-hydrate`）直接返回空名单 = **零行为变更**。保险库读取失败时上抛
   * （fail-closed：显式要求水合却读不动，不得静默降级成「凭据不存在」）。
   *
   * @param args 水合参数子集（vaultHydrate / vaultHydrateNames / vaultKeyFile / kvAdapter / kvFile）。
   * @returns 实际被水合的凭据名列表（未开启水合、缺少主密钥来源或保险库无命中时为空）。
   */
  protected async hydrateCredentials(args: CredentialHydrationArgs): Promise<readonly string[]> {
    if (args.vaultHydrate !== true) {
      return [];
    }
    // 无主密钥来源时 CryptoVault 只会在内存里随机生成密钥：既读不到既有密文，还可能凭空
    // 落下新的密钥文件。此处显式跳过并说明，避免「静默水合 0 项」被误读成「保险库是空的」。
    const keyFromEnv = process.env.OMNIHARNESS_VAULT_KEY;
    if ((keyFromEnv === undefined || keyFromEnv.length === 0) && args.vaultKeyFile === undefined) {
      process.stderr.write(
        '⚠️ --vault-hydrate 缺少主密钥来源（请设 OMNIHARNESS_VAULT_KEY 或 --vault-key-file），已跳过水合\n',
      );
      return [];
    }
    const kv = await new KvStoreFactory().createFor(args.kvAdapter, args.kvFile);
    const vault = new CryptoVault({ kv, keyFile: args.vaultKeyFile });
    try {
      const names = args.vaultHydrateNames ?? DEFAULT_CREDENTIAL_NAMES;
      const filled = await new CredentialResolver(vault).hydrateEnv(names);
      if (filled.length > 0) {
        process.stderr.write(`🔐 已从凭据保险库水合 ${filled.length} 项: ${filled.join(', ')}\n`);
      }
      return filled;
    } finally {
      await vault.close();
    }
  }

  /**
   * 装配运行时配置（端口即插即用）。
   * @param args 解析后的 CLI 参数。
   * @returns 已完成全部端口装配（模型 / 存储 / 审批 / 沙箱 / MCP 桥接等）的解析配置。
   */
  protected async buildConfig(args: CliArgs): Promise<ResolvedConfig> {
    if (args.native && !new NativeKernel().available()) {
      process.stderr.write(
        '⚠️ --native 已请求但原生内核不可用（请先 npm run native:build），已回退 TS 路径\n',
      );
    }
    // F3：凭据水合必须早于 buildModel——模型适配器与模型路由都在构造期直接读 process.env。
    await this.hydrateCredentials(args);
    const model = this.buildModel(args);
    const config = ConfigFactory.build({
      workspaceRoot: args.workspace,
      // V2：默认步数 16→32——16 在真实任务上频繁跑满无果（2026-09-08 真机复现），
      // 且失控检测（LoopGuard）已兜住空转风险，放宽不增加失控成本。
      maxSteps: args.maxSteps ?? 32,
      // V2.1（A3）：模型重试默认开——生产环境最蠢的单点故障是一次 429 报废整回合。
      // --no-model-retry 显式关闭；策略（3 次 / 500ms 指数退避 / 尊重 Retry-After）见 RetryingModel。
      modelRetry: args.modelRetry ?? true,
      // F3：模型熔断默认开——重试吸收单次调用的瞬时抖动，熔断识别「下游持续不可用」并短路
      // （冷却期不发起任何网络调用，冷却到期自动半开探测）。--no-model-circuit-breaker 关闭。
      modelCircuitBreaker: args.modelCircuitBreaker ?? true,
      ...(args.modelCircuitBreakerThreshold !== undefined
        ? { modelCircuitBreakerThreshold: args.modelCircuitBreakerThreshold }
        : {}),
      ...(args.modelCircuitBreakerOpenMs !== undefined
        ? { modelCircuitBreakerOpenMs: args.modelCircuitBreakerOpenMs }
        : {}),
      // (U4) RLVR 进化闭环：仅显式 `--evolution-rlvr` 时写入 partial；缺省不写 = 零行为变更。
      // 未给 `--rlvr-verify` 时 verifyCommand 缺省 → RLVR 奖励恒 0（无绿样本进回放，fail-closed 安全旁路）。
      ...(args.evolutionRlvr === true
        ? {
            evolutionRlvr: {
              enabled: true,
              ...(args.rlvrVerify !== undefined ? { verifyCommand: args.rlvrVerify } : {}),
              ...(args.rlvrSamples !== undefined ? { samplesPerPrompt: args.rlvrSamples } : {}),
              ...(args.rlvrMinReward !== undefined ? { minReward: args.rlvrMinReward } : {}),
              ...(args.rlvrCandidates !== undefined ? { maxCandidates: args.rlvrCandidates } : {}),
              ...(args.rlvrMinGain !== undefined ? { minGain: args.rlvrMinGain } : {}),
              autoRun: args.rlvrAutoRun === true,
            },
          }
        : {}),
      // (U6) A2A 互操作：仅显式 `--a2a` 时写入 partial；缺省不写 = 零行为变更。
      ...(args.a2a === true
        ? {
            a2a: {
              enabled: true,
              ...(args.a2aPort !== undefined ? { port: args.a2aPort } : {}),
              ...(args.a2aPeer !== undefined ? { peerEndpoint: args.a2aPeer } : {}),
              ...(args.a2aTransport !== undefined ? { transport: args.a2aTransport } : {}),
            },
          }
        : {}),
      // V2.1（B4）：回合 token 预算（未设不进 config，维持缺省关闭语义）。
      ...(args.turnTokenBudget !== undefined && args.turnTokenBudget > 0
        ? { turnTokenBudget: args.turnTokenBudget }
        : {}),
      // V2.1（A1）：--stream-text 时注入带文本通道的 live 视图（正文 token 级打到 stdout）。
      ...(args.streamText === true
        ? { live: new ConsoleLiveView(process.stderr, process.stdout) }
        : {}),
      model,
      storage: await this.buildStorage(args),
      approvals: this.buildApproval(args, model),
      sandbox: this.buildSandbox(args),
      escalation: this.buildEscalation(args),
      elevatedSandbox: this.buildElevatedSandbox(args),
      events: args.events === 'console' ? new ConsoleEventPort() : new SilentEventPort(),
      extraTools: await this.loadCustomTools(args.toolFiles),
      compactionMaxTokens:
        args.compactionMax ??
        (args.contextWindow !== undefined ? Math.floor(args.contextWindow * 0.75) : undefined),
      spillAdapter: args.spillAdapter,
      spillMaxInlineBytes: args.spillMax,
      spillPreviewBytes: args.spillPreview,
      subagentMaxDepth: args.subagentMaxDepth,
      subagentConcurrency: args.subagentConcurrency,
      subagentMaxSteps: args.subagentMaxSteps,
      workers: this.buildWorkers(args),
      native: args.native,
      planMode: args.planMode,
      promptInjectionGuard: args.promptInjectionGuard === true,
      deferredTools: args.deferTools
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      lspServer: this.parseLsp(args.lsp),
      longTermMemoryEncryption: args.memoryEncrypt === true,
      longTermMemoryKeyFile: args.memoryKeyFile,
      modelRouter: await this.resolveModelRouter(args),
      fragments: [
        '你是 OmniHarness 的 AI 助手，运行在用户工作区中。你的首要目标是直接、高效地完成用户任务。\n' +
          '核心行为准则（必须遵守）：\n' +
          '1. 优先直接回答或执行。不要为收集信息而反复调用探索工具。\n' +
          '2. 当用户说"重新试试"、"再试一次"、"再来一次"或类似模糊重试指令时，基于已有上下文和当前工作区状态直接执行最合理的下一步，绝对不要反问用户，也禁止调用 `ask_user` 来澄清"重试哪个"。\n' +
          '3. `ask_user` 工具只在确实需要用户做选择或提供关键缺失信息时使用；禁止用它澄清模糊指令，尤其禁止在"重新试试"场景使用。\n' +
          '4. 工具执行失败时，先分析原因再重试，不要无意义循环调用同一工具。\n' +
          '5. 当指令模糊或缺少上下文时，最多只做一次轻量确认；若仍不确定，直接给出最佳推测回答，或简短说明需要用户补充哪些信息。严禁为"理解用户在指什么"而连续调用 shell/list_dir/read_file/memory_search 等探索工具。\n' +
          '6. 若用户要求"重新试试"但你找不到明确的前序任务，执行以下固定 SOP（必须严格遵守，不得偏离）：\n' +
          '   a) 调用 `todo_read` 一次；\n' +
          '   b) 调用 `read_file` 一次，读取当前工作区的 `package.json`；\n' +
          '   c) 基于以上信息：\n' +
          '      - 若 `todo` 非空，按待办最优先项继续执行；\n' +
          '      - 若 `todo` 为空，调用 `shell` 一次执行轻量状态检查：`git status --short`，读取结果并立即停止工具调用、输出总结。\n' +
          '   d) 禁止在此 SOP 中调用 `memory_search`（避免被历史测试噪音误导）、`list_dir`、`run_code`、或 `read_file` 读取 tmp/前序线程文件。绝对禁止反问"你想重试哪个"，禁止执行 `npm run build`/`tsc` 等可能触发环境内存限制的重量级命令。',
      ],
    });
    await this.bridgeMcpServers(args, config);
    return config;
  }

  /**
   * 解析模型路由配置（#B4）：--model-router-file 读取并 merge 到 --model-router（CLI 优先）。
   * @param args 解析后的 CLI 参数（读取 modelRouter / modelRouterFile）。
   * @returns 合并后的模型路由配置；两者均未提供时返回 undefined。
   */
  protected async resolveModelRouter(args: CliArgs): Promise<ModelRouterConfig | undefined> {
    let merged = args.modelRouter;
    if (args.modelRouterFile !== undefined) {
      const fileCfg = JSON.parse(
        await readFile(resolve(args.modelRouterFile), 'utf8'),
      ) as ModelRouterConfig;
      merged = merged === undefined ? fileCfg : { ...fileCfg, ...merged };
    }
    return merged;
  }

  /**
   * 构建 worker 注册表（--worker-dsh 时注册真实 dsh worker 替代演示 worker）。
   * @param args 解析后的 CLI 参数（读取 workerDsh 任务名）。
   * @returns 已注册 worker 的注册表；未配置 worker 时返回 undefined。
   */
  protected buildWorkers(args: CliArgs): WorkerRegistry | undefined {
    if (args.workerDsh === undefined) {
      return undefined;
    }
    const registry = new WorkerRegistry();
    registry.register(dshWorker.task(args.workerDsh));
    return registry;
  }

  /**
   * 桥接外部 MCP 服务器的工具到本地工具注册表。
   * @param args 解析后的 CLI 参数（读取 mcpServers 服务器清单）。
   * @param config 已装配的运行时配置（取其中的工具端口挂载桥接工具）。
   
 * @returns 无返回值。
*/
  protected async bridgeMcpServers(args: CliArgs, config: ResolvedConfig): Promise<void> {
    if (args.mcpServers.length === 0) {
      return;
    }
    const tools = config.tools;
    if (!(tools instanceof RegistryToolPort)) {
      process.stderr.write('MCP 桥接需 RegistryToolPort 型工具端口，已跳过\n');
      return;
    }
    const gateway = new McpGateway({
      registry: tools,
      context: { sessionId: 'mcp-bridge', workspaceRoot: args.workspace },
      servers: args.mcpServers,
    });
    this.gateway = gateway;
    const results = await gateway.connectAll();
    process.stderr.write(`MCP 桥接:\n${formatBridgeResults(results)}\n`);
  }

  /**
   * 构建模型端口。
   * @param args 解析后的 CLI 参数（读取 modelAdapter / apiKey / baseUrl / model 等）。
   * @returns 按 modelAdapter 选择的模型端口；缺省适配器回退 MockModel，密钥缺失时抛错。
   */
  protected buildModel(
    args: CliArgs,
  ): MockModel | OpenAiCompatibleModel | AnthropicModel | ResponsesModel | LlamaCppModel {
    if (args.modelAdapter === 'openai') {
      const apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
      const baseUrl = args.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
      // 模型选择：CLI/配置文件显式 > 环境变量 > openai 适配器兜底。绝不能用
      // `args.model === CliDefaults.model` 字符串比较——配置文件里写
      // "deepseek-v4-flash" 恰好等于默认占位时会被误判为「没显式传」并被
      // 覆写成 'gpt-4o-mini'，发到 deepseek 端点 → HTTP 400
      // （supported: deepseek-v4-pro/flash/vision-exp, you passed gpt-4o-mini）。
      const model = args.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
      if (apiKey === undefined) {
        throw new Error('openai 适配器需要 --api-key 或环境变量 OPENAI_API_KEY');
      }
      return new OpenAiCompatibleModel({ baseUrl, apiKey, model });
    }
    if (args.modelAdapter === 'anthropic') {
      const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY;
      const baseUrl = args.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
      const model = args.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';
      if (apiKey === undefined) {
        throw new Error('anthropic 适配器需要 --api-key 或环境变量 ANTHROPIC_API_KEY');
      }
      return new AnthropicModel({ baseUrl, apiKey, model });
    }
    if (args.modelAdapter === 'responses') {
      const apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
      const baseUrl = args.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
      const model = args.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
      if (apiKey === undefined) {
        throw new Error('responses 适配器需要 --api-key 或环境变量 OPENAI_API_KEY');
      }
      return new ResponsesModel({ baseUrl, apiKey, model });
    }
    if (args.modelAdapter === 'llamacpp') {
      const baseUrl = args.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      const model = args.model ?? process.env.OLLAMA_MODEL ?? 'llama3';
      return new LlamaCppModel({ baseUrl, model, apiKey: args.apiKey });
    }
    return new MockModel();
  }

  /**
   * 构建存储端口。
   * @param args 解析后的 CLI 参数（读取 storageAdapter / storageDir）。
   * @returns 按适配器选择的存储端口（jsonl / sqlite；sqlite 懒加载），缺省为内存存储。
   */
  protected async buildStorage(
    args: CliArgs,
  ): Promise<MemoryStorage | JsonlStorage | SqliteStorage> {
    if (args.storageAdapter === 'jsonl') {
      return new JsonlStorage(args.storageDir ?? process.cwd());
    }
    if (args.storageAdapter === 'sqlite') {
      // 懒加载：同 buildKv，避免 node:sqlite 拖垮旧 Node 的非 sqlite 路径
      const { SqliteStorage } = await import('../adapters/storage/sqliteStorage.js');
      return new SqliteStorage(args.storageDir ?? 'omniharness.db');
    }
    return new MemoryStorage();
  }

  /**
   * 构建审批端口。
   * @param args 解析后的 CLI 参数（读取 approval 策略名等）。
   * @param model 模型端口（guardian 策略需要 LLM 参与审批）。
   * @returns 按策略选择的审批端口；缺省为 AutoApproval（全放行）。
   */
  protected buildApproval(
    args: CliArgs,
    model: ModelPort,
  ): AutoApproval | DenyApproval | RuleApproval | GuardianApproval | PlanApproval {
    if (args.approval === 'deny') {
      return new DenyApproval();
    }
    if (args.approval === 'rules') {
      return this.buildRuleApproval(args);
    }
    if (args.approval === 'guardian') {
      return this.buildGuardianApproval(model);
    }
    if (args.approval === 'plan') {
      return new PlanApproval();
    }
    return new AutoApproval();
  }

  /**
   * 构建 Guardian 审批（预检直判 + 其余送 LLM 审查）。
   * @param model 模型端口，用于对预检未命中的请求做 LLM 审查。
   * @returns 配好危险命令预拒与常见只读命令预允的 Guardian 审批端口。
   */
  protected buildGuardianApproval(model: ModelPort): GuardianApproval {
    return new GuardianApproval({
      model,
      preDenyPatterns: dangerousCommands.defaults(),
      preAllowPatterns: [/^(?:echo|ls|cat|pwd|git status|node --version)\b/i],
    });
  }

  /**
   * 构建规则审批（默认档：未命中显式拒绝规则时放行，只拦 rm/del 等危险前缀）。
   * @param args 解析后的 CLI 参数（approvalAsk 决定未命中规则时的询问回应；permissionRules /
   *   permissionDefault 为 A2 配置注入的参数级规则与默认裁决）。
   * @returns 内置基线规则 + 配置自定义规则（经 commandGlob 支持参数级约束）的规则审批端口。
   */
  protected buildRuleApproval(args: CliArgs): RuleApproval {
    const builtin: ApprovalRule[] = [
      { toolName: 'read_file', decision: 'allow' },
      { toolName: 'shell', commandPrefix: 'rm ', decision: 'deny' },
      { toolName: 'shell', commandPrefix: 'del ', decision: 'deny' },
    ];
    // 自定义规则（A2，来自配置 permission.rules）：与内置合并。聚合语义为 deny 优先，
    // 故顺序不影响裁决；用户可借 commandGlob 表达参数级约束（如拒绝任何含 `curl | sh` 的命令）。
    const custom: ApprovalRule[] = (args.permissionRules ?? []).map((rule) => ({
      toolName: rule.toolName,
      commandPrefix: rule.commandPrefix,
      commandGlob: rule.commandGlob,
      decision: rule.decision,
    }));
    return new RuleApproval({
      rules: [...custom, ...builtin],
      defaultDecision: args.permissionDefault ?? 'allow',
      askHandler: async () => args.approvalAsk,
    });
  }

  /**
   * 构建沙箱端口（G4 多后端：经 SandboxManager 选 profile）。
   * @param args 解析后的 CLI 参数（读取 workspace 与 sandbox profile 名）。
   * @returns 按 profile 构建的沙箱端口。
   */
  protected buildSandbox(args: CliArgs): ReturnType<SandboxManager['build']> {
    return new SandboxManager(args.workspace).build(args.sandbox);
  }

  /**
   * 构建提权复核沙箱（#G3/G4：escalate 后以此复核放行）。
   * @param args 解析后的 CLI 参数（读取 workspace 与 elevatedSandbox profile 名）。
   * @returns 提权重试时使用的沙箱端口。
   */
  protected buildElevatedSandbox(args: CliArgs): ReturnType<SandboxManager['build']> {
    return new SandboxManager(args.workspace).build(args.elevatedSandbox);
  }

  /**
   * 构建升级审批端口（#G3/G4）。
   * @param args 解析后的 CLI 参数（读取 escalation 策略名）。
   * @returns 按策略选择的升级端口（ask 交互询问 / auto 自动放行 / deny 拒绝）。
   */
  protected buildEscalation(args: CliArgs): DenyEscalation | AskEscalation | AutoEscalation {
    if (args.escalation === 'ask') {
      return new AskEscalation({ askHandler: (req) => this.promptEscalation(req) });
    }
    if (args.escalation === 'auto') {
      return new AutoEscalation();
    }
    return new DenyEscalation();
  }

  /**
   * TTY 交互提权询问：非 TTY 一律 fail-closed 到 abort（不静默放行危险动作）。
   * @param request 升级请求（含工具名、目标与拒绝原因，用于向用户展示）。
   * @returns 用户确认 y/yes 时 'escalate'，其余（含非 TTY）一律 'abort'。
   */
  protected async promptEscalation(request: EscalationRequest): Promise<EscalationDecision> {
    if (!process.stdout.isTTY) {
      return 'abort';
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (
        await rl.question(
          `⚠️ 沙箱拒绝了 ${request.toolName}（${request.target}）：${request.reason}\n是否提权重试？[y/N] `,
        )
      )
        .trim()
        .toLowerCase();
      return answer === 'y' || answer === 'yes' ? 'escalate' : 'abort';
    } finally {
      rl.close();
    }
  }

  /**
   * 加载自定义工具。
   * @param files 自定义工具模块的文件路径列表。
   * @returns 各模块导出的工具定义（缺 definition 字段的条目被跳过）。
   */
  protected async loadCustomTools(files: readonly string[]): Promise<ExtraTool[]> {
    const tools: ExtraTool[] = [];
    for (const file of files) {
      const loaded = await loadToolModule(file);
      if ('definition' in loaded) {
        tools.push(loaded);
      }
    }
    return tools;
  }
}
