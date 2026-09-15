// 实验性公开 API（@beta）
// 本桶导出不在语义化版本合同内，可能随时增删改。稳定 API 见 ./index.ts。
// 外部消费方从 `omniharness/beta` 导入本桶。
// @beta 工具语义检索（#M1：BM25 工具 schema 检索 + 延迟加载）
export { Bm25Index, tokenize } from './search/bm25Index.js';
export type { Bm25Hit, Bm25Options } from './search/bm25Index.js';
export { ToolIndex } from './search/toolIndex.js';
export { ToolDiscovery } from './search/toolDiscovery.js';
export { ToolSearchTool } from './adapters/tool/meta/toolSearchTool.js';

// @beta 会话检索（#M2：BM25 会话历史检索，跨长对话 recall）
export type {
  RetrievalDoc,
  RetrievalHit,
  RetrievalPort,
  RetrievalRole,
} from './ports/intelligence/retrieval.js';
export { Bm25MemoryIndex } from './adapters/retrieval/bm25MemoryIndex.js';
export { MemorySearchTool } from './adapters/tool/memory/memorySearchTool.js';
export { FileLongTermMemory } from './adapters/memory/fileLongTermMemory.js';
export { MemoryExtractor } from './adapters/memory/memoryExtractor.js';
export { RememberTool, RecallTool } from './adapters/tool/memory/longTermMemoryTools.js';

// @beta 评估 / 基准 harness（C3）
export {
  runEvalSuite,
  runTask,
  scoreTask,
  formatEvalReport,
  loadSuiteFromJson,
  ScriptedModel,
  SMOKE_SUITE,
} from './eval/index.js';
export type {
  EvalSuite,
  EvalTask,
  EvalExpectation,
  EvalReport,
  EvalTaskResult,
  ScriptStep,
} from './eval/index.js';

// @beta 子智能体（#76：进程内独立 Agent 循环，深度限制 + 并发限流 + 父子关系）
export { SubagentOrchestrator } from './subagent/subagentOrchestrator.js';
export { SubagentRunner } from './subagent/subagentRunner.js';
export { subagentRuntimeFactory } from './subagent/subagentRuntimeFactory.js';
export { SubagentEventBridge } from './subagent/subagentEventBridge.js';
export { ToolSubset } from './subagent/toolSubset.js';
export { SubagentTool } from './adapters/tool/workflow/subagentTool.js';
export { ConcurrencyLimiter } from './util/concurrencyLimiter.js';
export { ParallelMap } from './util/parallelMap.js';
export type { SubagentPorts } from './subagent/subagentPorts.js';
export { portsOf } from './subagent/subagentPorts.js';
export type { SubagentOptions, SubagentRequest, SubagentResult } from './subagent/subagentTypes.js';

// @beta 自主目标循环（#S30：对标 dsh goal/ralph，多轮自主推进直到达成或达上限）
export { GoalRunner, DEFAULT_GOAL_MAX_ITERATIONS } from './autonomy/goalRunner.js';
export type { GoalResult, GoalRunnerOptions } from './autonomy/goalRunner.js';
export { GoalChecker, parseAchieved } from './autonomy/goalChecker.js';
export type { GoalCheck } from './autonomy/goalChecker.js';
export { RunGoalTool } from './adapters/tool/workflow/runGoalTool.js';
export { RUN_GOAL_TOOL_NAME } from './autonomy/goalToolNames.js';

// @beta 工作流 DAG 编排（#S31：对标 dsh agent-team / workflow DAG，多步依赖并发 + 失败传播）
export {
  WorkflowRunner,
  computeLevels,
  WorkflowCycleError,
  DEFAULT_WORKFLOW_CONCURRENCY,
} from './autonomy/workflowRunner.js';
export type {
  WorkflowDef,
  WorkflowStep,
  WorkflowResult,
  WorkflowStepResult,
} from './autonomy/workflowTypes.js';
export { RunWorkflowTool } from './adapters/tool/workflow/runWorkflowTool.js';
export { RUN_WORKFLOW_TOOL_NAME } from './autonomy/workflowToolNames.js';

// @beta LSP 代码导航（#S32：外启语言服务器进程走 stdio JSON-RPC，零依赖铁律下唯一合规接入方式）
export type {
  LspPort,
  LspLocation,
  LspPosition,
  LspRange,
  LspServerConfig,
} from './ports/tool/lsp.js';
export { LspProcessAdapter } from './adapters/lsp/lspProcessAdapter.js';
export { fileToUri, uriToFile } from './adapters/lsp/lspUri.js';
export {
  LspGoToDefinitionTool,
  LspFindReferencesTool,
  LspHoverTool,
  LspStatusTool,
} from './adapters/tool/lsp/lspTools.js';
export {
  LSP_GO_TO_DEFINITION_TOOL_NAME,
  LSP_FIND_REFERENCES_TOOL_NAME,
  LSP_HOVER_TOOL_NAME,
  LSP_STATUS_TOOL_NAME,
} from './adapters/lsp/lspToolNames.js';

// @beta Agent 密码学身份（#S33：对标 codex-rs/agent-identity 可移植核心，Ed25519 零依赖）
export type {
  AgentIdentityPort,
  AgentIdentityConfig,
  AgentIdentityClaims,
} from './ports/runtime/agentIdentity.js';
export {
  Ed25519AgentIdentity,
  generateAgentKeyMaterial,
} from './adapters/identity/ed25519AgentIdentity.js';
export {
  AgentIdentityTool,
  AGENT_IDENTITY_TOOL_NAME,
} from './adapters/tool/meta/agentIdentityTool.js';

// @beta 安全策略求值（#S34：对标 codex-rs/execpolicy 的「规则 → 决策」意图，安全子集零依赖）
export type {
  PolicyPort,
  PolicyRule,
  PolicyFacts,
  PolicyEffect,
  PolicyDecision,
} from './ports/runtime/policy.js';
export { SafePolicyEvaluator, compileExpression } from './adapters/policy/safePolicyEvaluator.js';
export { PolicyEvalTool, POLICY_EVAL_TOOL_NAME } from './adapters/tool/meta/policyEvalTool.js';

// @beta 安全护栏：提示注入拦截（opt-in，默认关；确定性正则扫描工具结果，命中即隔离）
export { scanForInjection, guardToolResult } from './security/promptInjectionGuard.js';
export type {
  InjectionHit,
  InjectionScan,
  InjectionSeverity,
} from './security/promptInjectionGuard.js';
// @beta 工具输出来源信任级（P4：按内容来源分级敏感——外部抓取严、本机命令宽，降误报）
export { ToolOutputTrust } from './security/toolOutputTrust.js';
export type { TrustTier } from './security/toolOutputTrust.js';

// @beta 零依赖 TUI 终端 UI（#S35：对标 codex-rs/tui 的「会话事件流渲染 + 交互」概念）
export {
  renderEventLine,
  renderStatusLine,
  truncateToWidth,
  clearLine,
  prompt,
  type TuiEvent,
  type TuiEventKind,
} from './tui/tuiRenderer.js';
export { renderStream, startInteractive, type InteractiveOptions } from './tui/interactive.js';

// @beta 计划 / 待办 / 提问协作态（#77：对标 dsh plan/todo/interaction）
export { TodoWriteTool, TodoReadTool } from './adapters/tool/plan/todoTool.js';
export { AskUserTool } from './adapters/tool/plan/askUserTool.js';
export { PlanWriteTool, PlanPresentTool, PlanReadTool } from './adapters/tool/plan/planTool.js';
export { MemoryTodo } from './adapters/todo/memoryTodo.js';
export { MemoryPlan } from './adapters/plan/memoryPlan.js';
export { ConsoleUserResponder } from './adapters/user/consoleUserResponder.js';
export { DefaultUserResponder } from './adapters/user/defaultUserResponder.js';
export { MemoryUserResponder } from './adapters/user/memoryUserResponder.js';
export { MUTATING_TOOLS } from './core/toolGate.js';
export type {
  UserResponder,
  AskQuestion,
  AskAnswer,
  AskOption,
} from './ports/runtime/userResponder.js';
export type { TodoPort, TodoItem, TodoStatus } from './ports/runtime/todo.js';
export type { PlanPort, PlanDraft, PlanState, PlanStep, PlanStatus } from './ports/runtime/plan.js';

// @beta Bundle 发布单元（#G-E 5.2/5.3：自包含 .ohb + 补丁层 + 可选 HMAC 签名）
export { packBundle, unpackBundle } from './plugin/pluginBundler.js';
export type {
  BundlePluginRef,
  BundlePatch,
  BundleManifest,
  PackBundleOptions,
  PackBundleResult,
  UnpackBundleOptions,
  UnpackBundleResult,
} from './plugin/pluginBundler.js';
// @beta 运行时消费 bundle 补丁层（注入 config 四层合并，叠在 profile 之上、低于 env）
export { loadBundlePatchLayer } from './config/configError.js';
