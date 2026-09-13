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
import { registerCheckpointTools } from '../adapters/tool/git/checkpointTool.js';
import { BudgetStatusTool } from '../adapters/tool/meta/budgetStatusTool.js';
import { ToolIndex } from '../search/toolIndex.js';
import { ToolDiscovery } from '../search/toolDiscovery.js';
import { TodoWriteTool, TodoReadTool } from '../adapters/tool/plan/todoTool.js';
import { AskUserTool } from '../adapters/tool/plan/askUserTool.js';
import { PlanWriteTool, PlanPresentTool, PlanReadTool } from '../adapters/tool/plan/planTool.js';
import { ReadFileTool } from '../adapters/tool/fs/readFileTool.js';
import { RegistryToolPort } from '../adapters/tool/registryToolPort.js';
import { ShellTool } from '../adapters/tool/shell/shellTool.js';
import { WriteFileTool } from '../adapters/tool/fs/writeFileTool.js';
import { ListDirTool } from '../adapters/tool/fs/listDirTool.js';
import { ApplyPatchTool } from '../adapters/tool/fs/applyPatchTool.js';
// web_search 仅当通过 extraTools 注入 search 实现时才注册，默认不暴露未配置的搜索工具，避免模型反复调用导致批量失败。
import { CodeExecutorTool } from '../adapters/tool/code/codeExecutorTool.js';
import { ToolGate } from '../core/toolGate.js';
import { DelegateTool } from '../adapters/tool/workflow/delegateTool.js';
import { WorkerRegistry } from '../worker/workerRegistry.js';
import { WorkerOrchestrator } from '../worker/workerOrchestrator.js';
import { SimpleWorker } from '../worker/simpleWorker.js';
import { SubagentOrchestrator } from '../subagent/subagentOrchestrator.js';
import { SubagentTool } from '../adapters/tool/workflow/subagentTool.js';
import { RunGoalTool } from '../adapters/tool/workflow/runGoalTool.js';
import { RunWorkflowTool } from '../adapters/tool/workflow/runWorkflowTool.js';
import { AgentFactory } from './agentFactory.js';
import {
  LspGoToDefinitionTool,
  LspFindReferencesTool,
  LspHoverTool,
  LspStatusTool,
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

/** 演示 worker 注册表（离线可用，可替换为真实 CLI worker）。 */
export function demoWorkers(): WorkerRegistry {
  const registry = new WorkerRegistry();
  registry.register(new SimpleWorker('demo-a', 'demo-a 完成任务'));
  registry.register(new SimpleWorker('demo-b', 'demo-b 完成任务'));
  return registry;
}

/** 注册内置 FS / 执行 / 代理工具（shell / read / write / list / patch / web / code / delegate / spill_read）。 */
function registerCoreTools(
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
  const shell = new ShellTool();
  const reader = new ReadFileTool();
  const writer = new WriteFileTool(seed.workspaceRoot);
  const lister = new ListDirTool(seed.workspaceRoot);
  const patcher = new ApplyPatchTool(seed.workspaceRoot);
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
  const delegator = new DelegateTool(new WorkerOrchestrator(workers ?? demoWorkers()));
  const spillReader = new SpillReadTool(seed.spill);
  // 绘图（草图）：把 Mermaid / SVG / 文本草图落成 .omniharness/sketches/ 下的文件，
  // 与 UI 的「+ → 绘图」入口配套——入口负责把模型切到「先画后写」的回合指令，本工具负责产物落地。
  const sketcher = new SketchWriteTool(seed.workspaceRoot);
  registry.register(shell.definition, (call, ctx) => shell.handle(call, ctx));
  registry.register(reader.definition, (call, ctx) => reader.handle(call, ctx));
  registry.register(writer.definition, (call, ctx) => writer.handle(call, ctx));
  registry.register(lister.definition, (call, ctx) => lister.handle(call, ctx));
  registry.register(patcher.definition, (call, ctx) => patcher.handle(call, ctx));
  registry.register(coder.definition, (call, ctx) => coder.handle(call, ctx));
  registry.register(delegator.definition, (call, ctx) => delegator.handle(call, ctx));
  registry.register(spillReader.definition, (call, ctx) => spillReader.handle(call, ctx));
  registry.register(sketcher.definition, (call, ctx) => sketcher.handle(call, ctx));
}

/** 注册自主智能体 / 检索工具（subagent / run_goal / run_workflow / todo / ask_user / plan* / tool_search / memory_search）。 */
function registerAgentTools(
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
  const spawner = new SubagentTool(
    new SubagentOrchestrator({ ...ports, tools: registry }, subagentOptions),
  );
  // #S30 自主目标循环：run_goal 派生进程内目标循环完成子目标（复用主循环 + 达成度判定）。
  // 经 AgentFactory（组合根注入）取得 Agent，避免 runGoalTool 直接依赖 core。
  const goalRunner = new RunGoalTool(
    { ...ports, tools: registry },
    { maxIterations: seed.goalMaxIterations },
    new AgentFactory(),
  );
  // #S31 工作流 DAG：run_workflow 派生进程内多步依赖编排（拓扑分层 + 并发闸门 + 失败传播）。
  const workflowRunner = new RunWorkflowTool({ ...ports, tools: registry });
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

/** 注册条件型工具（长期记忆 / 成本预算 / LSP / 身份 / 安全策略 / 检查点），仅当对应端口存在时注册。 */
function registerAuxiliaryTools(
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
    registerCheckpointTools(registry, checkpointManager);
  }
}

/** 默认工具端口：内置 17 工具（含 run_code/delegate/spill_read/subagent + #77 的 todo/ask_user/plan 三组 + #M1 的 tool_search + #M2 的 memory_search）+ 自定义工具。
 * web_search 默认不注册：它依赖外部搜索实现，未配置时会让模型反复调用并批量失败；需要时通过 extraTools 注入 {@link WebSearchTool}。 */
export function defaultTools(
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
): ToolPort {
  const registry = new RegistryToolPort();
  registerCoreTools(registry, seed, workers, planning);
  registerAgentTools(registry, seed, planning, discovery, retrieval);
  registerAuxiliaryTools(registry, seed, longTerm, costBudget, lsp, identity);
  for (const extra of extraTools ?? []) {
    registry.register(extra.definition, extra.handler);
  }
  if (deferredTools !== undefined && deferredTools.length > 0) {
    registry.markDeferred(deferredTools);
  }
  return registry;
}
