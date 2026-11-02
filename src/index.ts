// @public 端口层（标准插口）
export type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
  EscalationDecision,
  EscalationDeniedBy,
  EscalationPort,
  EscalationRequest,
  EventPort,
  EventType,
  ModelMessage,
  ModelCallError,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  SandboxAction,
  SandboxDecision,
  SandboxPort,
  SandboxDenialCategory,
  SessionEvent,
  ToolInputSink,
  SpillHandle,
  SpillPort,
  VortexRing,
  VortexRingPort,
  ResonantHit,
  ResonantMemoryPort,
  StoragePort,
  KvPort,
  VaultPort,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolParametersSchema,
  ToolPort,
  ToolResult,
  LongTermMemoryPort,
  MemoryFact,
} from './contracts/ports/index.ts';

// @public 核心
export { Agent } from './kernel/core/agent.ts';
export type { AgentResult } from './kernel/core/agent.ts';
export { AppendOnlyEventLog } from './kernel/core/appendOnlyEventLog.ts';
export { Container } from './kernel/core/container.ts';
export { Runtime, ServiceKeys } from './apps/composition/runtime.ts';
export type { OmniHarnessRuntime } from './apps/composition/runtime.ts';
export { SessionRecorder } from './kernel/core/sessionRecorder.ts';
export { StepRunner } from './kernel/core/stepRunner.ts';
export { TurnRunner } from './kernel/core/turnRunner.ts';

// @public 配置
export { ConfigFactory } from './kernel/config/configFactory.ts';
export type { ExtraTool, OmniHarnessConfig } from './kernel/config/configFactory.ts';
// 配置分层（#G6：多层合并 + profile 覆盖 + key 别名归一化 + 严格校验）
export { ConfigFile } from './kernel/config/configFile.ts';
export type { FileConfig, FileMcpServer, LayeredOptions } from './kernel/config/configFile.ts';
export { ProfileLoader } from './kernel/config/profileLoader.ts';
export { ConfigError } from './kernel/config/configError.ts';

// @public 适配器（各端口默认实现）
export {
  AutoApproval,
  ConsoleEventPort,
  DenyApproval,
  JsonlStorage,
  JsonFileKv,
  MemoryKv,
  MemoryStorage,
  MockModel,
  OpenAiCompatibleModel,
  PassthroughSandbox,
  PolicySandbox,
  RestrictedSandbox,
  WindowsNativeSandbox,
  UnsupportedSandbox,
  SandboxManager,
  SandboxDenial,
  DenyEscalation,
  AskEscalation,
  AutoEscalation,
  ReadFileTool,
  RegistryToolPort,
  ShellTool,
  SilentEventPort,
  SqliteKv,
  CryptoVault,
  EnvVault,
  ConsoleLiveView,
  CompositeLiveView,
  WebLiveView,
} from './kernel/adapters/index.ts';
export type { LiveBroadcaster } from './kernel/adapters/live/webLiveView.ts';
export type { OpenAiCompatibleConfig } from './kernel/adapters/model/openAiCompatibleModel.ts';
export { LlamaCppModel } from './kernel/adapters/model/llamaCppModel.ts';
export type { LlamaCppConfig } from './kernel/adapters/model/llamaCppModel.ts';
export { NetworkEgressGuard, EgressBlockedError } from './kernel/adapters/sandbox/networkEgressGuard.ts';
export { DaemonController } from './apps/daemon/daemonController.ts';
export { RoutineScheduler } from './apps/daemon/routineScheduler.ts';
export type { Routine, RoutineSchedule, RoutineModelAdapter } from './apps/daemon/routineScheduler.ts';
export { ResponsesModel } from './kernel/adapters/model/responsesModel.ts';
export type { ResponsesConfig } from './kernel/adapters/model/responsesModel.ts';
export { RetryingModel, DEFAULT_RETRY_POLICY } from './kernel/adapters/model/retryingModel.ts';
export type { RetryPolicy, DelayFn } from './kernel/adapters/model/retryingModel.ts';
export { BudgetedModel } from './kernel/adapters/model/budgetedModel.ts';
export { CostBudget } from './kernel/adapters/model/costBudget.ts';
export type { BudgetSnapshot } from './kernel/adapters/model/costBudget.ts';
export {
  RoutePricing,
  DEFAULT_ROUTE_PRICING,
  DEFAULT_FALLBACK_PRICE,
} from './kernel/adapters/model/routePricing.ts';
export type { ToolHandler } from './kernel/adapters/tool/toolHandler.ts';

// @public hooks 兼容层（通用 / claude-code 事件格式映射）
export { GenericHooksMapper } from './apps/hooksCompat/genericHooksMapper.ts';
export { ClaudeCodeHooksMapper } from './apps/hooksCompat/claudeCodeHooksMapper.ts';
export { HooksCompatAdapter } from './apps/hooksCompat/hooksCompatAdapter.ts';
export type { HookEventEnvelope, HookConsumer } from './apps/hooksCompat/formats.ts';

// @public 上下文 / 工具
export { ContextAssembler } from './kernel/context/contextAssembler.ts';
export { TokenEstimator } from './kernel/context/tokenEstimator.ts';
export { ContextCompactor } from './kernel/context/contextCompactor.ts';
export type { CompactionOptions, CompactionResult } from './kernel/context/contextCompactor.ts';
// Spill：超大工具输出外溢（#74）
export { SpillPolicy } from './kernel/context/spillPolicy.ts';
export type { SpillPolicyOptions } from './kernel/context/spillPolicy.ts';
export { ToolResultSpiller } from './kernel/context/toolResultSpiller.ts';
export type { SpillerOptions } from './kernel/context/toolResultSpiller.ts';
export { FileSpill } from './kernel/adapters/spill/fileSpill.ts';
export { MemorySpill } from './kernel/adapters/spill/memorySpill.ts';
export { SpillReadTool } from './kernel/adapters/tool/meta/spillReadTool.ts';
export { WorkspaceGuard, PathTraversalError } from './kernel/util/workspaceGuard.ts';
export { OutputDecoder } from './kernel/util/outputDecoder.ts';

// @public 插件系统（cordis-lite）
export { PluginManager } from './kernel/plugin/pluginManager.ts';
export type { Plugin, PluginApplyContext, PluginMeta } from './kernel/plugin/plugin.ts';
export { PermissionGate, PermissionDeniedError } from './kernel/plugin/permissionGate.ts';
export type { PermissionDecision } from './kernel/plugin/permissionGate.ts';
export type { PluginPermission } from './kernel/plugin/permission.ts';
export { ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, Permission } from './kernel/plugin/permission.ts';

// @public 门禁 / PTC 代码执行
export { ToolGate } from './kernel/core/toolGate.ts';
export { SupervisorKernel } from './kernel/supervisor/supervisorKernel.ts';
export type {
  SupervisorPort,
  SupervisorOptions,
  SafeMode,
  HealthSnapshot,
  HealthEntry,
  AuditSinkLike,
} from './contracts/ports/runtime/supervisor.ts';

// @public 燧-3 共振寻址 / 燧-4 涡环包（发明层 S+ 原语；共振寻址由 U1 统一基板 ResonantFieldEngine 承载）
export { ResonantFieldEngine } from './kernel/adapters/memory/resonantFieldEngine.ts';
export type { ResonantFieldOptions, ResonantFieldPort } from './contracts/ports/memory/resonantField.ts';
export {
  VortexRingPacket,
  VortexRingSpillAdapter,
} from './kernel/adapters/spill/vortexRingSpillAdapter.ts';
export { SparkController } from './kernel/spark/sparkController.ts';
export type { SparkCycleReport, SparkControllerOptions } from './kernel/spark/sparkController.ts';
// @public (D) 热方程记忆重加权 / 退火调度（知识基础算子）
export { HeatEquationAnnealer } from './kernel/adapters/memory/heatEquationAnnealer.ts';
export type { HeatAnnealerOptions } from './kernel/adapters/memory/heatEquationAnnealer.ts';
export type { MemoryAnnealer, AnnealStepReport } from './contracts/ports/memory/memoryAnnealing.ts';
// @public (E) 宇宙网记忆 / QEC 记忆 / 免疫异常监控（发明层 S+ 原语，I-P1-2/3/5）
export type { CosmicWebPort, WebConsolidationReport } from './contracts/ports/memory/cosmicWeb.ts';
export { QECEncoder } from './kernel/adapters/memory/qecEncoder.ts';
export type { QECOptions } from './kernel/adapters/memory/qecEncoder.ts';
export type { QECEncoderPort, QECStatus, QECReport } from './contracts/ports/intelligence/qec.ts';
export { ImmuneMonitor } from './kernel/adapters/monitoring/immuneMonitor.ts';
export type { ImmuneMonitorOptions } from './kernel/adapters/monitoring/immuneMonitor.ts';
export type {
  ImmuneMonitorPort,
  AnomalyAlert,
  ImmuneSelfReport,
} from './contracts/ports/intelligence/immune.ts';
// @public (P2) 信念·组合·拓扑 — 自然梯度信念 / 粒子滤波信念（I-P2-2/3，信息几何）
export { NaturalGradientBelief } from './kernel/adapters/belief/naturalGradientBelief.ts';
export type { NaturalGradientOptions } from './kernel/adapters/belief/naturalGradientBelief.ts';
export { ParticleFilterBelief } from './kernel/adapters/belief/particleFilterBelief.ts';
export type { ParticleFilterOptions } from './kernel/adapters/belief/particleFilterBelief.ts';
export type {
  MetacognitionPort,
  BeliefSnapshot,
  BeliefUpdateReport,
  BeliefKlComponent,
} from './contracts/ports/intelligence/metacognition.ts';
export { EigenSpectrum, type Spectrum } from './kernel/util/eigenspectrum.ts';

// @public (P2) 组合·拓扑 — CRISPR 精确技能编辑（I-P2-4）+ 相变固化（I-P2-5）
export { CRISPRSkillEditor } from './kernel/adapters/skill/crisprSkillEditor.ts';
export type { CRISPRSkillEditorOptions } from './kernel/adapters/skill/crisprSkillEditor.ts';
export type {
  CRISPRSkillEditorPort,
  CrisprEditSpec,
  CrisprEditReport,
} from './contracts/ports/runtime/skillEdit.ts';
export { CapabilityCrystallizer } from './kernel/adapters/skill/capabilityCrystallizer.ts';
export type { CapabilityCrystallizerOptions } from './kernel/adapters/skill/capabilityCrystallizer.ts';
export type {
  CapabilityCrystallizerPort,
  CrystallizationReport,
  FrozenCapability,
} from './contracts/ports/intelligence/capability.ts';

// @public (P3) 高原创试点 — 刻蚀记忆 / 元素组合基元 / 对称破缺 / 禁闭色荷（I-P3-1~4）
export { InsightEtchingEngine } from './kernel/adapters/memory/insightEtchingEngine.ts';
export type { InsightEtchingOptions } from './kernel/adapters/memory/insightEtchingEngine.ts';
export type {
  InsightEtchingPort,
  EtchEvent,
  EtchTrace,
  EtchNode,
  EtchConduction,
  EtchBranch,
} from './contracts/ports/memory/insightEtching.ts';
export { ElementComposer } from './kernel/adapters/skill/elementComposer.ts';
export type {
  ElementComposerPort,
  ElementDef,
  CompoundCapability,
} from './contracts/ports/intelligence/elementComposer.ts';
export { SymmetryBreakingEngine } from './kernel/adapters/monitoring/symmetryBreakingEngine.ts';
export type { SymmetryBreakingOptions } from './kernel/adapters/monitoring/symmetryBreakingEngine.ts';
export type {
  SymmetryBreakingPort,
  SymmetryBreakReport,
  SymmetryState,
  UsageSample,
} from './contracts/ports/intelligence/symmetryBreaking.ts';
export { ConfinementEngine } from './kernel/adapters/monitoring/confinementEngine.ts';
export type { ConfinementOptions } from './kernel/adapters/monitoring/confinementEngine.ts';
export type {
  ConfinementPort,
  CapabilityCharge,
  BoundCapability,
  ConfinementVerdict,
  Charge,
} from './contracts/ports/runtime/confinement.ts';

// @public 进化闭环（P1：发现 → 评估 → 晋升，fail-closed）
export { FailClosedEvolutionGate } from './kernel/evolution/failClosedEvolutionGate.ts';
export type {
  BenchmarkFn,
  SafetyCheck,
  FailClosedEvolutionGateOptions,
} from './kernel/evolution/failClosedEvolutionGate.ts';
export { TwistDiscoveryEngine } from './kernel/evolution/twistDiscoveryEngine.ts';
export type { TwistDiscoveryOptions } from './kernel/evolution/twistDiscoveryEngine.ts';
export { EvolutionControllerImpl } from './kernel/evolution/evolutionControllerImpl.ts';
export { RlvrController } from './kernel/evolution/rlvrController.ts';
export type { RlvrEvolutionOptions, RlvrEvolutionBundle } from './kernel/evolution/rlvrController.ts';
export type { VerifiableRewardFn } from './kernel/evolution/verifiableReward.ts';
export { Benchmark } from './kernel/evolution/benchmark.ts';
export type {
  Candidate,
  PromotionVerdict,
  EvolutionGate,
  DiscoveryEngine,
  EvolutionController,
  EvolutionControllerOptions,
} from './contracts/ports/runtime/evolution.ts';
export { CodeInterpreter } from './kernel/adapters/tool/code/codeInterpreter.ts';
export type { CodeInterpreterDeps, CodeRunResult } from './kernel/adapters/tool/code/codeInterpreter.ts';
export { CodeExecutorTool } from './kernel/adapters/tool/code/codeExecutorTool.ts';
export type { CodeExecutorOptions } from './kernel/adapters/tool/code/codeExecutorTool.ts';

// @public Skills 系统
export type { Skill } from './kernel/skill/skill.ts';
export { SkillRegistry } from './kernel/skill/skillRegistry.ts';

// @public app-server / 协议
export { JsonRpc } from './apps/server/core/jsonRpc.ts';
export type {
  RpcError,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from './apps/server/core/jsonRpc.ts';
export { LineTransport } from './apps/server/transport/lineTransport.ts';
export type { Transport } from './apps/server/transport/lineTransport.ts';
export { AppServer } from './apps/server/core/appServer.ts';
export type { AppServerOptions } from './apps/server/core/appServer.ts';

// @public 单源 schema / SDK 生成
export { protocolSchema } from './contracts/schema/protocolSchema.ts';
export type {
  FieldSchema,
  FieldType,
  MethodSchema,
  ProtocolSchema,
} from './contracts/schema/protocolSchema.ts';
export { CodeGenerator } from './contracts/schema/codeGenerator.ts';

// @public 跨 harness worker 编排
export type { Worker, WorkerRequest, WorkerResult } from './kernel/worker/worker.ts';
export { CliWorker } from './kernel/worker/cliWorker.ts';
export type { CliWorkerOptions } from './kernel/worker/cliWorker.ts';
export { ExternalCliWorker } from './kernel/worker/externalCliWorker.ts';
export type { ExternalCliWorkerSpec } from './kernel/worker/externalCliWorker.ts';
export { SimpleWorker } from './kernel/worker/simpleWorker.ts';
export { WorkerRegistry } from './kernel/worker/workerRegistry.ts';
export { WorkerOrchestrator } from './kernel/worker/workerOrchestrator.ts';
export type { DelegateTask } from './kernel/worker/workerOrchestrator.ts';
export { DelegateTool } from './kernel/adapters/tool/workflow/delegateTool.ts';

// @public MCP 网关（对外暴露工具 / 桥接外部 MCP 服务器）
export { McpProtocol } from './protocols/mcp/mcpProtocol.ts';
export type {
  McpCallToolResult,
  McpCacheableResult,
  McpCapabilities,
  McpClientCapabilities,
  McpInitializeResult,
  McpInputRequestSpec,
  McpInputRequests,
  McpInputRequiredResult,
  McpInputResponses,
  McpInputSchema,
  McpResourceTemplate,
  McpServerInfo,
  McpSubscriptionFilter,
  McpTextContent,
  McpToolDescriptor,
} from './protocols/mcp/mcpProtocol.ts';
export { McpToolMapper } from './protocols/mcp/mcpToolMapper.ts';
export { McpServer } from './protocols/mcp/mcpServer.ts';
export type { McpServerOptions } from './protocols/mcp/mcpServer.ts';
export { McpClient } from './protocols/mcp/mcpClient.ts';
export type { McpClientOptions } from './protocols/mcp/mcpClient.ts';
export { McpStatelessClient } from './protocols/mcp/mcpStatelessClient.ts';
export type {
  McpStatelessClientOptions,
  McpSubscription,
  McpSubscriptionHandlers,
} from './protocols/mcp/mcpStatelessClient.ts';
export type {
  McpInputRequiredContext,
  McpInputRequiredDecision,
  McpInputRequiredPort,
} from './contracts/ports/mcp/mcpInputRequiredPort.ts';
export { McpAskUserInputHandler } from './protocols/mcp/mcpAskUserInputHandler.ts';
export { McpApprovalInputHandler } from './protocols/mcp/mcpApprovalInputHandler.ts';
export { McpCompositeInputHandler } from './protocols/mcp/mcpCompositeInputHandler.ts';
export { McpSseResponseTransport } from './protocols/mcp/mcpSseResponseTransport.ts';
export type { McpSseFrame, McpSseWriter } from './protocols/mcp/mcpSseResponseTransport.ts';
export { McpStdioTransport } from './protocols/mcp/mcpStdioTransport.ts';
export type { McpStdioHandle, McpStdioServerOptions } from './protocols/mcp/mcpStdioTransport.ts';
export { McpConnector } from './protocols/mcp/mcpConnector.ts';
export type { McpConnection, McpConnectorOptions } from './protocols/mcp/mcpConnector.ts';
export { McpGateway } from './protocols/mcp/mcpGateway.ts';
export type { McpBridgeResult, McpGatewayOptions, McpServerConfig } from './protocols/mcp/mcpGateway.ts';
export { McpServerCommand } from './protocols/mcp/mcpServerCommand.ts';

// @public 原生内核（FFI 下沉 #65：Node 进程内直调 Rust 内核，N-API / .node）
export { NativeKernel, NativeKernelUnavailableError } from './kernel/native/index.ts';
export type { NativeDecision } from './kernel/native/index.ts';
export { NativeBackend } from './kernel/native/index.ts';
export type { NativeToolRunner } from './kernel/native/index.ts';

// @public 企业管控（D2：SSO / 合规导出）
export { EnterpriseAuth, OidcClient } from './apps/enterprise/index.ts';
export type {
  OidcProviderConfig,
  OidcDiscovery,
  PkcePair,
  TokenSet,
  Jwk,
  JwtParts,
  AuthState,
} from './apps/enterprise/index.ts';
export { AuditExporter } from './apps/server/services/auditExporter.ts';
export type { ComplianceReport, ComplianceReportMeta } from './apps/server/services/auditExporter.ts';

// @public 版本契约（API 版本锚点，见 docs/API_STABILITY.md）
export { API_VERSION } from './version.ts';
export type { ApiVersion } from './version.ts';

// @public 长期运行遥测（P4, I-P4-3：回填基座 + 闭环参数收紧）
export { JsonlRuntimeTelemetry } from './kernel/adapters/telemetry/jsonlRuntimeTelemetry.ts';
export type { JsonlRuntimeTelemetryOptions } from './kernel/adapters/telemetry/jsonlRuntimeTelemetry.ts';
export type {
  RuntimeObservation,
  RuntimeTelemetryPort,
  TelemetryChainReport,
  TelemetryKind,
  TelemetryProvenance,
} from './contracts/ports/runtime/runtimeTelemetry.ts';

// @public 太初数学内核（Genesis Core）：可推演代数态射 + 多模态 + 自适应
// 统一内核——把能耗/成本建模为交换幺半群、算子的指称语义、记账不变量账本、
// 多模态函子（原生支持多模态）、按工况重配置管线的收敛型自适应控制器。
export {
  emptyCost,
  Algebra,
  costMonoid,
  JOULES_PER_TOKEN_ESTIMATE,
  Mathutil,
  type Cost,
  type Semigroup,
  type Monoid,
  ModalityPort,
  type Modality,
  type ModalityKind,
  type OperatorFn,
  operatorMonoid,
  type OperatorResult,
  Ledger,
  RegimeCost,
  fuseOperator,
  pruneOperator,
  type GenesisState,
  type Regime,
} from './kernel/genesis/index.ts';

// @public 上下文效率层（自研 · 无第三方依赖）：确定性压缩 + 前缀稳定性治理（KV 缓存命中率根因变量）
export {
  Canonical,
  PrefixStability,
  type PromptSegment,
  type PromptBuildOptions,
  type PrefixStabilityReport,
  DeterministicCompressor,
  type SegmentKind,
  type ContextSegment,
  type CompressOptions,
  type CompressStageMetric,
  type CompressReport,
  type CompressResult,
} from './kernel/context/index.ts';
