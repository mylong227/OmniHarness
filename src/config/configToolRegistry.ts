import type { RetrievalPort } from '../ports/intelligence/retrieval.js';
import { CostBudget } from '../adapters/model/costBudget.js';
import { SpillReadTool } from '../adapters/tool/meta/spillReadTool.js';
import { SketchWriteTool } from '../adapters/tool/meta/sketchWriteTool.js';
import { ToolSearchTool } from '../adapters/tool/meta/toolSearchTool.js';
import { MemorySearchTool } from '../adapters/tool/memory/memorySearchTool.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import { RememberTool, RecallTool } from '../adapters/tool/memory/longTermMemoryTools.js';
import { CheckpointManager } from '../core/checkpointManager.js';
import { eventFactory } from '../core/eventFactory.js';
import { GitWorkspaceSnapshot } from '../adapters/workspace/gitWorkspaceSnapshot.js';
import { CheckpointTool } from '../adapters/tool/git/checkpointTool.js';
import { BudgetStatusTool } from '../adapters/tool/meta/budgetStatusTool.js';
import { ToolIndex } from '../search/toolIndex.js';
import { ToolDiscovery } from '../search/toolDiscovery.js';
import { TodoWriteTool, TodoReadTool } from '../adapters/tool/plan/todoTool.js';
import { AskUserTool } from '../adapters/tool/plan/askUserTool.js';
import { PlanWriteTool, PlanPresentTool, PlanReadTool } from '../adapters/tool/plan/planTool.js';
import { ReadFileTool } from '../adapters/tool/fs/readFileTool.js';
import { EditFileTool } from '../adapters/tool/fs/editFileTool.js';
import { FileContentLedger } from '../adapters/tool/fs/fileContentLedger.js';
import { GrepTool } from '../adapters/tool/fs/grepTool.js';
import { GlobTool } from '../adapters/tool/fs/globTool.js';
import { WebFetchTool } from '../adapters/tool/web/webFetchTool.js';
import { ViewImageTool } from '../adapters/tool/media/viewImageTool.js';
import { BrowserScreenshotTool } from '../adapters/tool/browser/browserScreenshotTool.js';
import { RegistryToolPort } from '../adapters/tool/registryToolPort.js';
import { ShellTool } from '../adapters/tool/shell/shellTool.js';
import { ShellInteractiveTool } from '../adapters/tool/shell/shellInteractiveTool.js';
import { ShellCommandPolicy } from '../adapters/tool/shell/shellCommandPolicy.js';
import { BackgroundJobRegistry } from '../adapters/tool/shell/backgroundJobRegistry.js';
import { ShellJobTool } from '../adapters/tool/shell/shellJobTool.js';
import { WriteFileTool } from '../adapters/tool/fs/writeFileTool.js';
import { ListDirTool } from '../adapters/tool/fs/listDirTool.js';
import { ApplyPatchTool } from '../adapters/tool/fs/applyPatchTool.js';
// web_search 仅当通过 extraTools 注入 search 实现时才注册，默认不暴露未配置的搜索工具，避免模型反复调用导致批量失败。
import { CodeExecutorTool } from '../adapters/tool/code/codeExecutorTool.js';
import { ToolGate } from '../core/toolGate.js';
import { SelfChecklist } from '../eval/selfChecklist.js';
import { SelfVerifyPolicy } from '../adapters/tool/verify/selfVerifyPolicy.js';
import { MutationTargets } from '../adapters/tool/verify/mutationTargets.js';
import { SelfVerifyingToolPort } from '../adapters/tool/verify/selfVerifyingToolPort.js';
import { PostWriteDiagnosticsPort } from '../adapters/tool/verify/postWriteDiagnosticsPort.js';
import { ShellTestCommandRunner } from '../adapters/tool/verify/shellTestCommandRunner.js';
import { DelegateTool } from '../adapters/tool/workflow/delegateTool.js';
import { WorkerRegistry } from '../worker/workerRegistry.js';
import { WorkerOrchestrator } from '../worker/workerOrchestrator.js';
import { SimpleWorker } from '../worker/simpleWorker.js';
import { SubagentOrchestrator } from '../subagent/subagentOrchestrator.js';
import { DEFAULT_SUBAGENT_MAX_STEPS } from '../subagent/subagentTypes.js';
import { SubagentTool } from '../adapters/tool/workflow/subagentTool.js';
import { RunGoalTool } from '../adapters/tool/workflow/runGoalTool.js';
import { RunWorkflowTool } from '../adapters/tool/workflow/runWorkflowTool.js';
import { AgentFactory } from './agentFactory.js';
import {
  LspGoToDefinitionTool,
  LspFindReferencesTool,
  LspHoverTool,
  LspStatusTool,
  LspDiagnosticsTool,
  LspDocumentSymbolsTool,
  LspCodeActionTool,
  LspWorkspaceSymbolsTool,
} from '../adapters/tool/lsp/lspTools.js';
import type { LspPort } from '../ports/tool/lsp.js';
import { AgentIdentityTool } from '../adapters/tool/meta/agentIdentityTool.js';
import { PolicyEvalTool } from '../adapters/tool/meta/policyEvalTool.js';
import type { AgentIdentityPort } from '../ports/runtime/agentIdentity.js';
import type { UserResponder } from '../ports/runtime/userResponder.js';
import type { TodoPort } from '../ports/runtime/todo.js';
import type { PlanPort } from '../ports/runtime/plan.js';
import type { ToolPort } from '../ports/tool/tool.js';
import type { ExtraTool, SubagentPortSeed } from './configFactory.js';

/**
 * ConfigToolRegistry — 宿主类：收拢本模块原顶层内部函数（C7 顶层函数收敛），提供统一命名空间。
 */
export class ConfigToolRegistry {
  /**
   * 注册内置 FS / 执行 / 代理工具（shell / shell_job / read / write / edit / list / patch / grep / glob / web_fetch / view_image / code / delegate / spill_read）。
   * @param {RegistryToolPort} registry - registry
   * @param {SubagentPortSeed} seed - seed
   * @param {WorkerRegistry | undefined} workers - workers
   * @param {{ readonly todo: TodoPort; readonly plan: PlanPort; readonly userResponder: UserResponder; readonly planMode: boolean; }} planning - planning
   * @returns {void} - result
   */
  public static registerCoreTools(
    registry: RegistryToolPort,
    seed: SubagentPortSeed,
    workers: WorkerRegistry | undefined,
    planning: {
      readonly todo: TodoPort;
      readonly plan: PlanPort;
      readonly userResponder: UserResponder;
      readonly planMode: boolean;
    },
  ): void {
    // A3：shell 命令策略在**组合根**显式装配（不在工具内部自建），模式默认 audit
    // （解析 + 记录，零行为变更），`OMNI_SHELL_POLICY=enforce` 或后续 A2 权限档驱动为强制拒绝。
    // S1 内容账本：读记指纹、写前比对——读写工具必须共用**同一实例**才有意义（组合根单例）。
    const ledger = new FileContentLedger();
    // P2-⑫ 后台作业：shell 与 shell_job 必须共用同一注册表，否则二者看不到彼此的作业。
    const jobs = new BackgroundJobRegistry(seed.workspaceRoot);
    // 工具族共用同一策略实例：shell / shell_interactive 的裁决口径不漂移。
    const shellPolicy = new ShellCommandPolicy();
    const shell = new ShellTool({ policy: shellPolicy, jobs });
    // 交互式 / 持久 PTY：TTY 环境下把终端交给命令（`stdio: 'inherit'`），非 TTY 一律 fail-closed
    // 并给出可执行原因——补齐「TUI 类命令拿不到真终端」这条腿（2026-09-19 全量收口）。
    const interactiveShell = new ShellInteractiveTool({ policy: shellPolicy });
    const reader = new ReadFileTool(ledger);
    const writer = new WriteFileTool(seed.workspaceRoot, ledger);
    // 内容替换编辑（P0，2026-09-19）：模型不必给行号即可改代码；与 write_file/apply_patch 并列。
    const editor = new EditFileTool(seed.workspaceRoot, ledger);
    const lister = new ListDirTool(seed.workspaceRoot);
    const patcher = new ApplyPatchTool(seed.workspaceRoot, ledger);
    // 编码检索（P0，2026-09-19）：按内容 grep / 按路径 glob，补齐「查问题」这条腿（原只能靠 shell 手写 grep）。
    const grepper = new GrepTool(seed.workspaceRoot);
    const globber = new GlobTool(seed.workspaceRoot);
    // P2-⑬：web_fetch 自带实现（零密钥，故可默认注册）；view_image 走工具结果附件通道；
    // browser_screenshot 把「看一眼自己做的页面」补上（零依赖 CDP，headless Chrome/Edge）。
    const fetcher = new WebFetchTool();
    const viewer = new ViewImageTool(seed.workspaceRoot);
    const screenshotTool = new BrowserScreenshotTool(seed.workspaceRoot);
    const jobTool = new ShellJobTool(jobs);
    const coder = new CodeExecutorTool({
      gate: new ToolGate(
        seed.approvals,
        seed.sandbox,
        planning.plan,
        planning.planMode,
        seed.escalation,
        seed.elevatedSandbox,
      ),
      tools: registry,
    });
    const delegator = new DelegateTool(
      new WorkerOrchestrator(workers ?? ConfigToolRegistry.demoWorkers()),
    );
    const spillReader = new SpillReadTool(seed.spill);
    // 绘图（草图）：把 Mermaid / SVG / 文本草图落成 .omniharness/sketches/ 下的文件，
    // 与 UI 的「+ → 绘图」入口配套——入口负责把模型切到「先画后写」的回合指令，本工具负责产物落地。
    const sketcher = new SketchWriteTool(seed.workspaceRoot);
    registry.register(shell.definition, (call, ctx) => shell.handle(call, ctx));
    registry.register(interactiveShell.definition, (call, ctx) =>
      interactiveShell.handle(call, ctx),
    );
    registry.register(reader.definition, (call, ctx) => reader.handle(call, ctx));
    registry.register(writer.definition, (call, ctx) => writer.handle(call, ctx));
    registry.register(editor.definition, (call, ctx) => editor.handle(call, ctx));
    registry.register(lister.definition, (call, ctx) => lister.handle(call, ctx));
    registry.register(patcher.definition, (call, ctx) => patcher.handle(call, ctx));
    registry.register(grepper.definition, (call, ctx) => grepper.handle(call, ctx));
    registry.register(globber.definition, (call, ctx) => globber.handle(call, ctx));
    registry.register(fetcher.definition, (call, ctx) => fetcher.handle(call, ctx));
    registry.register(viewer.definition, (call, ctx) => viewer.handle(call, ctx));
    registry.register(screenshotTool.definition, (call, ctx) => screenshotTool.handle(call, ctx));
    registry.register(jobTool.definition, (call, ctx) => jobTool.handle(call, ctx));
    registry.register(coder.definition, (call, ctx) => coder.handle(call, ctx));
    registry.register(delegator.definition, (call, ctx) => delegator.handle(call, ctx));
    registry.register(spillReader.definition, (call, ctx) => spillReader.handle(call, ctx));
    registry.register(sketcher.definition, (call, ctx) => sketcher.handle(call, ctx));
  }

  /**
   * 注册自主智能体 / 检索工具（subagent / run_goal / run_workflow / todo / ask_user / plan* / tool_search / memory_search）。
   * @param {RegistryToolPort} registry - registry
   * @param {SubagentPortSeed} seed - seed
   * @param {{ readonly todo: TodoPort; readonly plan: PlanPort; readonly userResponder: UserResponder; readonly planMode: boolean; }} planning - planning
   * @param {ToolDiscovery} discovery - discovery
   * @param {RetrievalPort} retrieval - retrieval
   * @returns {void} - result
   */
  public static registerAgentTools(
    registry: RegistryToolPort,
    seed: SubagentPortSeed,
    planning: {
      readonly todo: TodoPort;
      readonly plan: PlanPort;
      readonly userResponder: UserResponder;
      readonly planMode: boolean;
    },
    discovery: ToolDiscovery,
    retrieval: RetrievalPort,
  ): void {
    const { subagent: subagentOptions, ...ports } = seed;
    // 三条子代路径（subagent / run_goal / run_workflow）共用同一份子代步数预算：
    // 此前 run_goal / run_workflow 直接读 `ports.maxSteps`（主会话步数），`--subagent-max-steps`
    // 只对 subagent 生效——同一个旋钮三条路两种口径，等于声明支持却半程失效。
    // 缺省口径与 SubagentOrchestrator 完全一致（DEFAULT_SUBAGENT_MAX_STEPS），避免「不传配置」
    // 时三条路又各自为政。
    const childPorts = {
      ...ports,
      tools: registry,
      maxSteps: subagentOptions.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS,
    };
    const spawner = new SubagentTool(new SubagentOrchestrator(childPorts, subagentOptions));
    // #S30 自主目标循环：run_goal 派生进程内目标循环完成子目标（复用主循环 + 达成度判定）。
    // 经 AgentFactory（组合根注入）取得 Agent，避免 runGoalTool 直接依赖 core。
    const goalRunner = new RunGoalTool(
      childPorts,
      { maxIterations: seed.goalMaxIterations },
      new AgentFactory(),
    );
    // #S31 工作流 DAG：run_workflow 派生进程内多步依赖编排（拓扑分层 + 并发闸门 + 失败传播）。
    const workflowRunner = new RunWorkflowTool(childPorts);
    // #77 计划/待办/提问协作态工具。
    const todoWriter = new TodoWriteTool(planning.todo, seed.events, eventFactory);
    const todoReader = new TodoReadTool(planning.todo);
    const asker = new AskUserTool(planning.userResponder, seed.events, eventFactory);
    const planWriter = new PlanWriteTool(planning.plan, seed.events, eventFactory);
    const planPresenter = new PlanPresentTool(
      planning.plan,
      planning.userResponder,
      seed.events,
      eventFactory,
    );
    const planReader = new PlanReadTool(planning.plan);
    registry.register(spawner.definition, (call, ctx) => spawner.handle(call, ctx));
    registry.register(goalRunner.definition, (call, ctx) => goalRunner.handle(call, ctx));
    registry.register(workflowRunner.definition, (call, ctx) => workflowRunner.handle(call, ctx));
    registry.register(todoWriter.definition, (call, ctx) => todoWriter.handle(call, ctx));
    registry.register(todoReader.definition, (call, ctx) => todoReader.handle(call, ctx));
    registry.register(asker.definition, (call, ctx) => asker.handle(call, ctx));
    registry.register(planWriter.definition, (call, ctx) => planWriter.handle(call, ctx));
    registry.register(planPresenter.definition, (call, ctx) => planPresenter.handle(call, ctx));
    registry.register(planReader.definition, (call, ctx) => planReader.handle(call, ctx));
    // #M1 工具语义检索：对全量工具建 BM25 索引，注册 tool_search；命中经 discovery 装载。
    const toolIndex = new ToolIndex(registry.list());
    const searchTool = new ToolSearchTool(toolIndex, discovery);
    registry.register(searchTool.definition, (call, ctx) => searchTool.handle(call, ctx));
    // #M2 会话检索：memory_search 对会话历史事件做 BM25 检索（事件由记录器索引进 retrieval）。
    const memoryTool = new MemorySearchTool(retrieval);
    registry.register(memoryTool.definition, (call, ctx) => memoryTool.handle(call, ctx));
  }

  /**
   * 注册条件型工具（长期记忆 / 成本预算 / LSP / 身份 / 安全策略 / 检查点），仅当对应端口存在时注册。
   * @param {RegistryToolPort} registry - registry
   * @param {SubagentPortSeed} seed - seed
   * @param {LongTermMemoryPort | undefined} longTerm - longTerm
   * @param {CostBudget | undefined} costBudget - costBudget
   * @param {LspPort | undefined} lsp - lsp
   * @param {AgentIdentityPort | undefined} identity - identity
   * @returns {void} - result
   */
  public static registerAuxiliaryTools(
    registry: RegistryToolPort,
    seed: SubagentPortSeed,
    longTerm: LongTermMemoryPort | undefined,
    costBudget: CostBudget | undefined,
    lsp: LspPort | undefined,
    identity: AgentIdentityPort | undefined,
  ): void {
    // #S28 长期记忆：remember/recall 跨会话持久 fact 读写（仅当长期记忆端口存在）。
    if (longTerm !== undefined) {
      const rememberTool = new RememberTool(longTerm);
      const recallTool = new RecallTool(longTerm);
      registry.register(rememberTool.definition, (call, ctx) => rememberTool.handle(call, ctx));
      registry.register(recallTool.definition, (call, ctx) => recallTool.handle(call, ctx));
    }
    // #S29 成本预算：budget_status 让模型随时自查花费/剩余/是否已熔断（仅当配置了硬预算）。
    if (costBudget !== undefined) {
      const budgetTool = new BudgetStatusTool(costBudget);
      registry.register(budgetTool.definition, (call, ctx) => budgetTool.handle(call, ctx));
    }
    // #S32 LSP 代码导航：go_to_definition / find_references / hover / status（仅当配置了语言服务器端口时注册，主循环零侵入）。
    if (lsp !== undefined) {
      const defTool = new LspGoToDefinitionTool(lsp);
      const refTool = new LspFindReferencesTool(lsp);
      const hoverTool = new LspHoverTool(lsp);
      const statusTool = new LspStatusTool(lsp);
      registry.register(defTool.definition, (call, ctx) => defTool.handle(call, ctx));
      registry.register(refTool.definition, (call, ctx) => refTool.handle(call, ctx));
      registry.register(hoverTool.definition, (call, ctx) => hoverTool.handle(call, ctx));
      registry.register(statusTool.definition, (call, ctx) => statusTool.handle(call, ctx));
      // 诊断：仅在适配器真的实现了 `diagnostics` 时才注册——避免暴露一个必然失败的死工具
      // （「声明了但跑不通」比「没有这个工具」更伤模型，它会反复重试）。
      if (lsp.diagnostics !== undefined) {
        const diagnosticsTool = new LspDiagnosticsTool(lsp);
        registry.register(diagnosticsTool.definition, (call, ctx) =>
          diagnosticsTool.handle(call, ctx),
        );
      }
      // 符号目录 / 代码操作：同样按**能力**而非「端口存在」放行（理由同上）。
      if (lsp.symbols !== undefined) {
        const symbolsTool = new LspDocumentSymbolsTool(lsp);
        registry.register(symbolsTool.definition, (call, ctx) => symbolsTool.handle(call, ctx));
      }
      if (lsp.codeActions !== undefined) {
        const codeActionTool = new LspCodeActionTool(lsp);
        registry.register(codeActionTool.definition, (call, ctx) =>
          codeActionTool.handle(call, ctx),
        );
      }
      // 全局符号搜索：同样按**能力**而非「端口存在」放行——只实现导航的适配器拿到它只会白跑一次。
      if (lsp.workspaceSymbols !== undefined) {
        const workspaceSymbolsTool = new LspWorkspaceSymbolsTool(lsp);
        registry.register(workspaceSymbolsTool.definition, (call, ctx) =>
          workspaceSymbolsTool.handle(call, ctx),
        );
      }
    }
    if (identity !== undefined) {
      const idTool = new AgentIdentityTool(identity);
      registry.register(idTool.definition, (call, ctx) => idTool.handle(call, ctx));
    }
    // #S34 安全策略求值：纯本地逻辑、零外部依赖，始终注册（让模型可策略化审批决策）。
    {
      const policyTool = new PolicyEvalTool();
      registry.register(policyTool.definition, (call, ctx) => policyTool.handle(call, ctx));
    }
    // #B2 会话检查点/回滚：checkpoint/rollback 工具（始终注册，提供 Escape 式安全网）。
    {
      const checkpointManager = new CheckpointManager(seed.storage, {
        snapshotter: new GitWorkspaceSnapshot(),
        workspaceRoot: seed.workspaceRoot,
      });
      CheckpointTool.registerCheckpointTools(registry, checkpointManager);
    }
  }

  /**
   * 装配自验证回环装饰器（P3）：把工具端口包一层，在**写类工具改了源码**后自动跑受限测试，
   * 把失败摘要回灌到该次工具结果（详见 `SelfVerifyingToolPort`）。
   *
   * 为什么在组合根定义触发条件：`MUTATING_TOOLS` 属 `core/`，而 `adapters/` **不得 import core**
   * （`arch:gate` 硬规则）。故「什么算改了源码」在此判定后以谓词注入装饰器，装饰器本身零 core 依赖。
   *
   * 假完成探测复用 `SelfChecklist`（同一份占位符口径，不另写一份规则）。
   *
   * **2026-09-19 修复（静默旁路）**：触发条件原为 `String(args['path'])`，而 `apply_patch` 的
   * `path` 按设计可省略 ⇒ 不带 path 的补丁**一次都不触发自验证**（探针实测 `runnerCalls +0`），
   * 假完成探测也因只认 `content` 而对补丁恒静默跳过。现统一改走 {@link MutationTargets}
   * （补丁头、新增行、`new_string` 全覆盖），两条静默旁路一并堵死。
   *
   * @param registry 已注册全部工具的内层端口。
   * @param policy 受控预算（命令 / 超时 / 冷却 / 每会话次数 / 摘要行数）。
   * @param workspaceRoot 工作区根（测试命令 cwd）。
   * @returns 装饰后的工具端口（对外行为除「写源码后追加回灌」外完全不变）。
   */
  public static withSelfVerify(
    registry: ToolPort,
    policy: SelfVerifyPolicy,
    workspaceRoot: string,
  ): ToolPort {
    return new SelfVerifyingToolPort(registry, {
      policy,
      workspaceRoot,
      runner: new ShellTestCommandRunner(),
      shouldVerify: (toolName, args) =>
        MutationTargets.of(toolName, args).some((path) =>
          SelfVerifyPolicy.isVerifiableTarget(path),
        ),
      probeFakeCompletion: async (toolName, args) => {
        const content = MutationTargets.addedText(toolName, args);
        if (content === undefined) {
          return undefined;
        }
        const targets = MutationTargets.of(toolName, args);
        const verdict = await new SelfChecklist().noPlaceholders(content).evaluate();
        return verdict.passed
          ? undefined
          : `产物 ${targets.join('、') || toolName} 含未完成标记（${verdict.failures.join(', ')}）`;
      },
    });
  }

  /**
   * 装配「写后自动诊断回灌」装饰器（P1-⑦ 后半）：写源码成功后自动取 LSP 诊断，
   * 只在确有 **error 级**诊断时把结果追加到该次工具输出（详见 {@link PostWriteDiagnosticsPort}）。
   *
   * 为什么只在 `lsp.diagnostics` 存在时装配：未实现诊断的适配器装上也只是空转，
   * 徒增一层包装（并给每次写调用多一次无意义的 await）；`lsp` 未注入时同理直接返回内层。
   *
   * @param inner 内层工具端口（已注册全部工具）。
   * @param lsp LSP 端口（须实现可选的 `diagnostics`）。
   * @param workspaceRoot 工作区根（把相对目标解析为绝对路径）。
   * @returns 装饰后的工具端口；LSP 未实现诊断时原样返回 `inner`。
   */
  public static withPostWriteDiagnostics(
    inner: ToolPort,
    lsp: LspPort,
    workspaceRoot: string,
  ): ToolPort {
    const diagnose = lsp.diagnostics;
    if (diagnose === undefined) {
      return inner;
    }
    return new PostWriteDiagnosticsPort(inner, {
      workspaceRoot,
      diagnostics: (file) => diagnose.call(lsp, file),
      shouldCheck: (toolName, args) =>
        MutationTargets.of(toolName, args).some((path) =>
          SelfVerifyPolicy.isVerifiableTarget(path),
        ),
    });
  }

  /** 演示 worker 注册表（离线可用，可替换为真实 CLI worker）。 */
  public static demoWorkers(): WorkerRegistry {
    const registry = new WorkerRegistry();
    registry.register(new SimpleWorker('demo-a', 'demo-a 完成任务'));
    registry.register(new SimpleWorker('demo-b', 'demo-b 完成任务'));
    return registry;
  }

  /**
   * 默认工具端口：条目由 {@link ConfigToolRegistry.registerCoreTools}（文件读写/检索/执行/委派）、
   * {@link ConfigToolRegistry.registerAgentTools}（子代理/目标/工作流/待办/提问/计划/检索发现）、
   * {@link ConfigToolRegistry.registerAuxiliaryTools}（记忆、预算、LSP、身份、策略，**按注入端口条件注册**）
   * 三处汇总而成，故不写死总数——总数随 `longTerm`/`costBudget`/`lsp`/`identity` 是否为 undefined 而变
   * （实测 `ConfigFactory.build` 默认路径 31 个，注入 LSP 后 36 个）。另可经 `extraTools` 追加自定义工具，
   * 且**同名时显式注入覆盖内置默认**（先反注册再注册，便于整体替换 `web_fetch` 等内置实现）。
   * web_search 默认不注册：它依赖外部搜索实现，未配置时会让模型反复调用并批量失败；需要时通过 extraTools 注入 {@link WebSearchTool}。
   * web_fetch / view_image 默认注册：前者自带实现（零密钥），后者只读本地图片——都不会"未配置即批量失败"。
   * 两个后置装饰器按条件叠加（都属"写后质量信号"，不装配即零行为）：
   *  - `lsp.diagnostics` 可用 ⇒ {@link ConfigToolRegistry.withPostWriteDiagnostics}（写后错误级诊断）；
   *  - `selfVerify` 非空（P3）⇒ {@link ConfigToolRegistry.withSelfVerify}（写源码后跑受限测试并回灌失败摘要）。 */
  public static defaultTools(
    seed: SubagentPortSeed,
    extraTools: readonly ExtraTool[] | undefined,
    workers: WorkerRegistry | undefined,
    planning: {
      readonly todo: TodoPort;
      readonly plan: PlanPort;
      readonly userResponder: UserResponder;
      readonly planMode: boolean;
    },
    discovery: ToolDiscovery,
    retrieval: RetrievalPort,
    deferredTools: readonly string[] | undefined,
    longTerm: LongTermMemoryPort | undefined,
    costBudget: CostBudget | undefined,
    lsp: LspPort | undefined,
    identity: AgentIdentityPort | undefined,
    selfVerify?: SelfVerifyPolicy | undefined,
  ): ToolPort {
    const registry = new RegistryToolPort();
    ConfigToolRegistry.registerCoreTools(registry, seed, workers, planning);
    ConfigToolRegistry.registerAgentTools(registry, seed, planning, discovery, retrieval);
    ConfigToolRegistry.registerAuxiliaryTools(registry, seed, longTerm, costBudget, lsp, identity);
    for (const extra of extraTools ?? []) {
      // 显式注入**优先于内置默认**：`web_fetch` / `view_image` 等内置工具允许被调用方整体替换
      // （如换成带鉴权的抓取实现）。故先反注册同名内置再注册，避免撞上 `RegistryToolPort` 的重名拦截。
      // 重名拦截本身不放松——它留在**内置注册**处，专门拦「内置之间互撞」这类真缺陷。
      registry.unregister(extra.definition.name);
      registry.register(extra.definition, extra.handler);
    }
    if (deferredTools !== undefined && deferredTools.length > 0) {
      registry.markDeferred(deferredTools);
    }
    // P1-⑦ 写后自动诊断：装配了 LSP 且适配器支持 diagnostics 时包一层（否则原样返回）。
    const withDiagnostics =
      lsp === undefined
        ? registry
        : ConfigToolRegistry.withPostWriteDiagnostics(registry, lsp, seed.workspaceRoot);
    // P3 自验证回环：仅在策略存在（= 仓库有测试脚本且配置开启）时包装；
    // 缺省不包装 ⇒ 与 P3 之前逐字等价（零行为变更）。
    if (selfVerify === undefined) {
      return withDiagnostics;
    }
    return ConfigToolRegistry.withSelfVerify(withDiagnostics, selfVerify, seed.workspaceRoot);
  }
}
