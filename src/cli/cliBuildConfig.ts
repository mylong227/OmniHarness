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
import { ConfigFactory } from '../config/omniharnessConfig.js';
import type { ResolvedConfig } from '../config/omniharnessConfig.js';
import type { ExtraTool } from '../config/omniharnessConfig.js';
import { ConsoleEventPort } from '../adapters/event/consoleEventPort.js';
import { SilentEventPort } from '../adapters/event/silentEventPort.js';
import { PluginRegistry } from '../plugin/registry.js';
import { AuditSink } from '../server/audit.js';
import { NetworkEgressGuard, parseAllowList } from '../adapters/sandbox/networkEgress.js';
import { WorkerRegistry } from '../worker/workerRegistry.js';
import { DshWorker } from '../worker/dshWorker.js';
import { RegistryToolPort } from '../adapters/tool/registryToolPort.js';
import { McpGateway } from '../mcp/mcpGateway.js';
import { formatBridgeResults } from '../mcp/mcpServerCommand.js';
import { MockModel } from '../adapters/model/mockModel.js';
import { OpenAiCompatibleModel } from '../adapters/model/openaiCompatibleModel.js';
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
import { DangerousCommands } from '../adapters/sandbox/dangerousCommands.js';
import { SandboxManager } from '../adapters/sandbox/sandboxManager.js';
import { DenyEscalation } from '../adapters/escalation/denyEscalation.js';
import { AskEscalation } from '../adapters/escalation/askEscalation.js';
import { AutoEscalation } from '../adapters/escalation/autoEscalation.js';
import type { EscalationRequest, EscalationDecision } from '../ports/escalation.js';
import type { ModelPort } from '../ports/model.js';
import type { ModelRouterConfig } from '../config/configFile.js';
import type { LspServerConfig } from '../ports/lsp.js';
import { ToolLoader } from './toolLoader.js';
import type { CliArgs } from './args.js';
import { CliDefaults } from './args.js';

/** ExecCli 继承链根基类：共享接线与配置装配。 */
export class CliBuildConfig {
  /** 当前活动的 MCP 网关（执行结束后由子类 closeGateway 关闭子进程）。 */
  protected gateway: McpGateway | undefined;

  /** 取标志值。 */
  protected flagValue(args: readonly string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  }

  /** 取数字标志值。 */
  protected flagNumber(args: readonly string[], flag: string): number | undefined {
    const value = this.flagValue(args, flag);
    return value === undefined ? undefined : Number.parseInt(value, 10);
  }

  /** 收集可重复旗标的所有取值（如 --allow a --allow b）。 */
  protected collectFlags(args: readonly string[], flag: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === flag) {
        const value = args[i + 1];
        if (value !== undefined) {
          values.push(value);
        }
      }
    }
    return values;
  }

  /** 解析 --lsp "server cmd args" 为 LSP 服务器配置（命令 + 参数）。 */
  protected parseLsp(raw: string | undefined): LspServerConfig | undefined {
    if (raw === undefined || raw.trim() === '') {
      return undefined;
    }
    const parts = raw.trim().split(/\s+/);
    const serverCommand = parts[0] ?? '';
    const serverArgs = parts.slice(1);
    return { serverCommand, serverArgs };
  }

  /** 解析 JSON 对象参数（缺省空对象）。 */
  protected parseJsonObject(raw: string | undefined): Record<string, unknown> {
    if (raw === undefined || raw.trim() === '') {
      return {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /** 构造插件注册表：--dir 覆盖安装目录，打包源基准为仓库根。 */
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

  /** 构造审计 sink：--audit-dir / --audit-file 或 env OMNI_AUDIT_DIR 指定落盘位置；未指定则 no-op（不写审计）。 */
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

  /** 装配运行时配置（端口即插即用）。 */
  protected async buildConfig(args: CliArgs): Promise<ResolvedConfig> {
    if (args.native && !new NativeKernel().available()) {
      process.stderr.write(
        '⚠️ --native 已请求但原生内核不可用（请先 npm run native:build），已回退 TS 路径\n',
      );
    }
    const model = this.buildModel(args);
    const config = ConfigFactory.build({
      workspaceRoot: args.workspace,
      // V2：默认步数 16→32——16 在真实任务上频繁跑满无果（2026-09-08 真机复现），
      // 且失控检测（LoopGuard）已兜住空转风险，放宽不增加失控成本。
      maxSteps: args.maxSteps ?? 32,
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

  /** 解析模型路由配置（#B4）：--model-router-file 读取并 merge 到 --model-router（CLI 优先）。 */
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

  /** 构建 worker 注册表（--worker-dsh 时注册真实 dsh worker 替代演示 worker）。 */
  protected buildWorkers(args: CliArgs): WorkerRegistry | undefined {
    if (args.workerDsh === undefined) {
      return undefined;
    }
    const registry = new WorkerRegistry();
    registry.register(DshWorker.task(args.workerDsh));
    return registry;
  }

  /** 桥接外部 MCP 服务器的工具到本地工具注册表。 */
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

  /** 构建模型端口。 */
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

  /** 构建存储端口。 */
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

  /** 构建审批端口。 */
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

  /** 构建 Guardian 审批（预检直判 + 其余送 LLM 审查）。 */
  protected buildGuardianApproval(model: ModelPort): GuardianApproval {
    return new GuardianApproval({
      model,
      preDenyPatterns: DangerousCommands.defaults(),
      preAllowPatterns: [/^(?:echo|ls|cat|pwd|git status|node --version)\b/i],
    });
  }

  /** 构建规则审批（默认档：未命中显式拒绝规则时放行，只拦 rm/del 等危险前缀）。 */
  protected buildRuleApproval(args: CliArgs): RuleApproval {
    const rules: ApprovalRule[] = [
      { toolName: 'read_file', decision: 'allow' },
      { toolName: 'shell', commandPrefix: 'rm ', decision: 'deny' },
      { toolName: 'shell', commandPrefix: 'del ', decision: 'deny' },
    ];
    return new RuleApproval({
      rules,
      defaultDecision: 'allow',
      askHandler: async () => args.approvalAsk,
    });
  }

  /** 构建沙箱端口（G4 多后端：经 SandboxManager 选 profile）。 */
  protected buildSandbox(args: CliArgs): ReturnType<SandboxManager['build']> {
    return new SandboxManager(args.workspace).build(args.sandbox);
  }

  /** 构建提权复核沙箱（#G3/G4：escalate 后以此复核放行）。 */
  protected buildElevatedSandbox(args: CliArgs): ReturnType<SandboxManager['build']> {
    return new SandboxManager(args.workspace).build(args.elevatedSandbox);
  }

  /** 构建升级审批端口（#G3/G4）。 */
  protected buildEscalation(args: CliArgs): DenyEscalation | AskEscalation | AutoEscalation {
    if (args.escalation === 'ask') {
      return new AskEscalation({ askHandler: (req) => this.promptEscalation(req) });
    }
    if (args.escalation === 'auto') {
      return new AutoEscalation();
    }
    return new DenyEscalation();
  }

  /** TTY 交互提权询问：非 TTY 一律 fail-closed 到 abort（不静默放行危险动作）。 */
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

  /** 加载自定义工具。 */
  protected async loadCustomTools(files: readonly string[]): Promise<ExtraTool[]> {
    const tools: ExtraTool[] = [];
    for (const file of files) {
      const loaded = await ToolLoader.load(file);
      if ('definition' in loaded) {
        tools.push(loaded);
      }
    }
    return tools;
  }
}
