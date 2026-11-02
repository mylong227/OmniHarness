// 实验性公开 API（@beta）
// 本桶导出不在语义化版本合同内，可能随时增删改。稳定 API 见 ./index.ts。
// 外部消费方从 `omniharness/beta` 导入本桶。
// @beta 工具语义检索（#M1：BM25 工具 schema 检索 + 延迟加载）
export { Bm25Index } from './kernel/search/bm25Index.ts';
export type { Bm25Hit, Bm25Options } from './kernel/search/bm25Index.ts';
export { ToolIndex } from './kernel/search/toolIndex.ts';
export { ToolDiscovery } from './kernel/search/toolDiscovery.ts';
export { ToolSearchTool } from './kernel/adapters/tool/meta/toolSearchTool.ts';

// @beta 会话检索（#M2：BM25 会话历史检索，跨长对话 recall）
export type {
  RetrievalDoc,
  RetrievalHit,
  RetrievalPort,
  RetrievalRole,
} from './contracts/ports/intelligence/retrieval.ts';
export { Bm25MemoryIndex } from './kernel/adapters/retrieval/bm25MemoryIndex.ts';
export { MemorySearchTool } from './kernel/adapters/tool/memory/memorySearchTool.ts';
export { FileLongTermMemory } from './kernel/adapters/memory/fileLongTermMemory.ts';
export { TemporalFactGraph } from './kernel/adapters/memory/temporalFactGraph.ts';
export type {
  TemporalConsolidateOptions,
  TemporalConsolidationReport,
  TemporalFactCard,
  TemporalFactHit,
} from './kernel/adapters/memory/temporalFactGraph.ts';
export { MemoryExtractor } from './kernel/adapters/memory/memoryExtractor.ts';
export { RememberTool, RecallTool } from './kernel/adapters/tool/memory/longTermMemoryTools.ts';

// @beta 确定性测试模型（可重放 ModelPort，零 API Key；核心单测用于驱动真实 Agent 主循环）
export { ScriptedModel } from './kernel/core/scriptedModel.ts';
export type { ScriptStep } from './kernel/core/scriptedModel.ts';

// @beta 子智能体（#76：进程内独立 Agent 循环，深度限制 + 并发限流 + 父子关系）
export { SubagentOrchestrator } from './kernel/subagent/subagentOrchestrator.ts';
export { SubagentRunner } from './kernel/subagent/subagentRunner.ts';
export { subagentRuntimeFactory } from './kernel/subagent/subagentRuntimeFactory.ts';
export { SubagentEventBridge } from './kernel/subagent/subagentEventBridge.ts';
export { ToolSubset } from './kernel/subagent/toolSubset.ts';
export { SubagentTool } from './kernel/adapters/tool/workflow/subagentTool.ts';
export { ConcurrencyLimiter } from './kernel/util/concurrency/concurrencyLimiter.ts';
export { ParallelMap } from './kernel/util/concurrency/parallelMap.ts';
export type { SubagentPortsShape } from './kernel/subagent/subagentPorts.ts';
export { SubagentPorts } from './kernel/subagent/subagentPorts.ts';
export type { SubagentOptions, SubagentRequest, SubagentResult } from './kernel/subagent/subagentTypes.ts';

// @beta 自主目标循环（#S30：自主目标循环，多轮自主推进直到达成或达上限）
export { GoalRunner, DEFAULT_GOAL_MAX_ITERATIONS } from './kernel/autonomy/goalRunner.ts';
export type { GoalResult, GoalRunnerOptions } from './kernel/autonomy/goalRunner.ts';
export { GoalChecker } from './kernel/autonomy/goalChecker.ts';
export type { GoalCheck } from './kernel/autonomy/goalChecker.ts';
export { RunGoalTool } from './kernel/adapters/tool/workflow/runGoalTool.ts';
export { RUN_GOAL_TOOL_NAME } from './kernel/autonomy/goalToolNames.ts';

// @beta 工作流 DAG 编排（#S31：多步 DAG 编排，多步依赖并发 + 失败传播）
export {
  WorkflowRunner,
  WorkflowCycleError,
  DEFAULT_WORKFLOW_CONCURRENCY,
} from './kernel/autonomy/workflowRunner.ts';
export type {
  WorkflowDef,
  WorkflowStep,
  WorkflowResult,
  WorkflowStepResult,
} from './kernel/autonomy/workflowTypes.ts';
export { RunWorkflowTool } from './kernel/adapters/tool/workflow/runWorkflowTool.ts';
export { RUN_WORKFLOW_TOOL_NAME } from './kernel/autonomy/workflowToolNames.ts';

// @beta LSP 代码导航（#S32：外启语言服务器进程走 stdio JSON-RPC，无第三方依赖铁律下唯一合规接入方式）
export type {
  LspPort,
  LspLocation,
  LspPosition,
  LspRange,
  LspServerConfig,
} from './contracts/ports/tool/lsp.ts';
export { LspProcessAdapter } from './kernel/adapters/lsp/lspProcessAdapter.ts';
export { LspUri } from './kernel/adapters/lsp/lspUri.ts';
export {
  LspGoToDefinitionTool,
  LspFindReferencesTool,
  LspHoverTool,
  LspStatusTool,
} from './kernel/adapters/tool/lsp/lspTools.ts';
export {
  LSP_GO_TO_DEFINITION_TOOL_NAME,
  LSP_FIND_REFERENCES_TOOL_NAME,
  LSP_HOVER_TOOL_NAME,
  LSP_STATUS_TOOL_NAME,
} from './kernel/adapters/lsp/lspToolNames.ts';

// @beta Agent 密码学身份（#S33：自研身份核心，Ed25519 无第三方依赖）
export type {
  AgentIdentityPort,
  AgentIdentityConfig,
  AgentIdentityClaims,
} from './contracts/ports/runtime/agentIdentity.ts';
export { Ed25519AgentIdentity } from './kernel/adapters/identity/ed25519AgentIdentity.ts';
export {
  AgentIdentityTool,
  AGENT_IDENTITY_TOOL_NAME,
} from './kernel/adapters/tool/meta/agentIdentityTool.ts';

// @beta 安全策略求值（#S34：「规则 → 决策」的安全子集，安全子集无第三方依赖）
export type {
  PolicyPort,
  PolicyRule,
  PolicyFacts,
  PolicyEffect,
  PolicyDecision,
} from './contracts/ports/runtime/policy.ts';
export { SafePolicyEvaluator } from './kernel/adapters/policy/safePolicyEvaluator.ts';
export { PolicyEvalTool, POLICY_EVAL_TOOL_NAME } from './kernel/adapters/tool/meta/policyEvalTool.ts';

// @beta 安全护栏：提示注入拦截（opt-in，默认关；确定性正则扫描工具结果，命中即隔离）
export { PromptInjectionGuard } from './kernel/security/promptInjectionGuard.ts';
export type {
  InjectionHit,
  InjectionScan,
  InjectionSeverity,
} from './kernel/security/promptInjectionGuard.ts';
// @beta 工具输出来源信任级（P4：按内容来源分级敏感——外部抓取严、本机命令宽，降误报）
export { ToolOutputTrust } from './kernel/security/toolOutputTrust.ts';
export type { TrustTier } from './kernel/security/toolOutputTrust.ts';

// @beta 无第三方依赖 TUI 终端 UI（#S35：/tui 的「会话事件流渲染 + 交互」概念）
export { TuiRenderer, type TuiEvent, type TuiEventKind } from './apps/tui/tuiRenderer.ts';
export { Interactive, type InteractiveOptions } from './apps/tui/interactive.ts';

// @beta 计划 / 待办 / 提问协作态（#77：plan/todo/interaction）
export { TodoWriteTool, TodoReadTool } from './kernel/adapters/tool/plan/todoTool.ts';
export { AskUserTool } from './kernel/adapters/tool/plan/askUserTool.ts';
export { PlanWriteTool, PlanPresentTool, PlanReadTool } from './kernel/adapters/tool/plan/planTool.ts';
export { MemoryTodo } from './kernel/adapters/todo/memoryTodo.ts';
export { MemoryPlan } from './kernel/adapters/plan/memoryPlan.ts';
export { ConsoleUserResponder } from './kernel/adapters/user/consoleUserResponder.ts';
export { DefaultUserResponder } from './kernel/adapters/user/defaultUserResponder.ts';
export { MemoryUserResponder } from './kernel/adapters/user/memoryUserResponder.ts';
export { MUTATING_TOOLS } from './kernel/core/toolGate.ts';
export type {
  UserResponder,
  AskQuestion,
  AskAnswer,
  AskOption,
} from './contracts/ports/runtime/userResponder.ts';
export type { TodoPort, TodoItem, TodoStatus } from './contracts/ports/runtime/todo.ts';
export type { PlanPort, PlanDraft, PlanState, PlanStep, PlanStatus } from './contracts/ports/runtime/plan.ts';

// @beta Bundle 发布单元（#G-E 5.2/5.3：自包含 .ohb + 补丁层 + 可选 HMAC 签名）
export { PluginBundler } from './kernel/plugin/pluginBundler.ts';
export type {
  BundlePluginRef,
  BundlePatch,
  BundleManifest,
  PackBundleOptions,
  PackBundleResult,
  UnpackBundleOptions,
  UnpackBundleResult,
} from './kernel/plugin/pluginBundler.ts';
// @beta 运行时消费 bundle 补丁层（注入 config 四层合并，叠在 profile 之上、低于 env）
export { ConfigError } from './kernel/config/configError.ts';

// @beta 成本预算与 token 归因（P5：缓存折抵 + per-tool 归因 + 软阈值信号）
export { TokenAttribution, INITIAL_BUCKET } from './kernel/observability/tokenAttribution.ts';
export type {
  TokenAttributionBucket,
  TokenAttributionReport,
  TokenAttributionTally,
} from './kernel/observability/tokenAttribution.ts';
export { DEFAULT_SOFT_RATIO } from './kernel/adapters/model/costBudget.ts';
export type { BudgetSnapshot } from './kernel/adapters/model/costBudget.ts';
