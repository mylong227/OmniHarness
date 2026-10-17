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
} from './ports/index.ts';

// @public 核心
export { Agent } from './core/agent.ts';
export type { AgentResult } from './core/agent.ts';
export { AppendOnlyEventLog } from './core/appendOnlyEventLog.ts';
export { Container } from './core/container.ts';
export { Runtime, ServiceKeys } from './composition/runtime.ts';
export type { OmniHarnessRuntime } from './composition/runtime.ts';
export { SessionRecorder } from './core/sessionRecorder.ts';
export { StepRunner } from './core/stepRunner.ts';
export { TurnRunner } from './core/turnRunner.ts';

// @public 配置
export { ConfigFactory } from './config/configFactory.ts';
export type { ExtraTool, OmniHarnessConfig } from './config/configFactory.ts';
// 配置分层（#G6：多层合并 + profile 覆盖 + key 别名归一化 + 严格校验）
export { ConfigFile } from './config/configFile.ts';
export type { FileConfig, FileMcpServer, LayeredOptions } from './config/configFile.ts';
export { ProfileLoader } from './config/profileLoader.ts';
export { ConfigError } from './config/configError.ts';

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
} from './adapters/index.ts';
export type { LiveBroadcaster } from './adapters/live/webLiveView.ts';
export type { OpenAiCompatibleConfig } from './adapters/model/openAiCompatibleModel.ts';
export { LlamaCppModel } from './adapters/model/llamaCppModel.ts';
export type { LlamaCppConfig } from './adapters/model/llamaCppModel.ts';
export { NetworkEgressGuard, EgressBlockedError } from './adapters/sandbox/networkEgressGuard.ts';
export { DaemonController } from './daemon/daemonController.ts';
export { RoutineScheduler } from './daemon/routineScheduler.ts';
export type { Routine, RoutineSchedule, RoutineModelAdapter } from './daemon/routineScheduler.ts';
export { ResponsesModel } from './adapters/model/responsesModel.ts';
export type { ResponsesConfig } from './adapters/model/responsesModel.ts';
export { RetryingModel, DEFAULT_RETRY_POLICY } from './adapters/model/retryingModel.ts';
export type { RetryPolicy, DelayFn } from './adapters/model/retryingModel.ts';
export { BudgetedModel } from './adapters/model/budgetedModel.ts';
export { CostBudget } from './adapters/model/costBudget.ts';
export type { BudgetSnapshot } from './adapters/model/costBudget.ts';
export {
  RoutePricing,
  DEFAULT_ROUTE_PRICING,
  DEFAULT_FALLBACK_PRICE,
} from './adapters/model/routePricing.ts';
export type { ToolHandler } from './adapters/tool/toolHandler.ts';

// @public hooks 兼容层（codex-claude / claude-code 事件格式映射）
export { CodexHooksMapper } from './hooksCompat/codexHooksMapper.ts';
export { ClaudeCodeHooksMapper } from './hooksCompat/claudeCodeHooksMapper.ts';
export { HooksCompatAdapter } from './hooksCompat/hooksCompatAdapter.ts';
export type { HookEventEnvelope, HookConsumer } from './hooksCompat/formats.ts';

// @public 上下文 / 工具
export { ContextAssembler } from './context/contextAssembler.ts';
export { TokenEstimator } from './context/tokenEstimator.ts';
export { ContextCompactor } from './context/contextCompactor.ts';
export type { CompactionOptions, CompactionResult } from './context/contextCompactor.ts';
// Spill：超大工具输出外溢（#74）
export { SpillPolicy } from './context/spillPolicy.ts';
export type { SpillPolicyOptions } from './context/spillPolicy.ts';
export { ToolResultSpiller } from './context/toolResultSpiller.ts';
export type { SpillerOptions } from './context/toolResultSpiller.ts';
export { FileSpill } from './adapters/spill/fileSpill.ts';
export { MemorySpill } from './adapters/spill/memorySpill.ts';
export { SpillReadTool } from './adapters/tool/meta/spillReadTool.ts';
export { WorkspaceGuard, PathTraversalError } from './util/workspaceGuard.ts';
export { OutputDecoder } from './util/outputDecoder.ts';

// @public 插件系统（cordis-lite）
export { PluginManager } from './plugin/pluginManager.ts';
export type { Plugin, PluginApplyContext, PluginMeta } from './plugin/plugin.ts';
export { PermissionGate, PermissionDeniedError } from './plugin/permissionGate.ts';
export type { PermissionDecision } from './plugin/permissionGate.ts';
export type { PluginPermission } from './plugin/permission.ts';
export { ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, Permission } from './plugin/permission.ts';

// @public 门禁 / PTC 代码执行
export { ToolGate } from './core/toolGate.ts';
export { SupervisorKernel } from './supervisor/supervisorKernel.ts';
export type {
  SupervisorPort,
  SupervisorOptions,
  SafeMode,
  HealthSnapshot,
  HealthEntry,
  AuditSinkLike,
} from './ports/runtime/supervisor.ts';

// @public 燧-3 共振寻址 / 燧-4 涡环包（发明层 S+ 原语；共振寻址由 U1 统一基板 ResonantFieldEngine 承载）
export { ResonantFieldEngine } from './adapters/memory/resonantFieldEngine.ts';
export type { ResonantFieldOptions, ResonantFieldPort } from './ports/memory/resonantField.ts';
export {
  VortexRingPacket,
  VortexRingSpillAdapter,
} from './adapters/spill/vortexRingSpillAdapter.ts';
export { SparkController } from './spark/sparkController.ts';
export type { SparkCycleReport, SparkControllerOptions } from './spark/sparkController.ts';
// @public (D) 热方程记忆重加权 / 退火调度（知识基础算子）
export { HeatEquationAnnealer } from './adapters/memory/heatEquationAnnealer.ts';
export type { HeatAnnealerOptions } from './adapters/memory/heatEquationAnnealer.ts';
export type { MemoryAnnealer, AnnealStepReport } from './ports/memory/memoryAnnealing.ts';
// @public (E) 宇宙网记忆 / QEC 记忆 / 免疫异常监控（发明层 S+ 原语，I-P1-2/3/5）
export type { CosmicWebPort, WebConsolidationReport } from './ports/memory/cosmicWeb.ts';
export { QECEncoder } from './adapters/memory/qecEncoder.ts';
export type { QECOptions } from './adapters/memory/qecEncoder.ts';
export type { QECEncoderPort, QECStatus, QECReport } from './ports/intelligence/qec.ts';
export { ImmuneMonitor } from './adapters/monitoring/immuneMonitor.ts';
export type { ImmuneMonitorOptions } from './adapters/monitoring/immuneMonitor.ts';
export type {
  ImmuneMonitorPort,
  AnomalyAlert,
  ImmuneSelfReport,
} from './ports/intelligence/immune.ts';
// @public (P2) 信念·组合·拓扑 — 自然梯度信念 / 粒子滤波信念（I-P2-2/3，信息几何）
export { NaturalGradientBelief } from './adapters/belief/naturalGradientBelief.ts';
export type { NaturalGradientOptions } from './adapters/belief/naturalGradientBelief.ts';
export { ParticleFilterBelief } from './adapters/belief/particleFilterBelief.ts';
export type { ParticleFilterOptions } from './adapters/belief/particleFilterBelief.ts';
export type {
  MetacognitionPort,
  BeliefSnapshot,
  BeliefUpdateReport,
  BeliefKlComponent,
} from './ports/intelligence/metacognition.ts';
export { EigenSpectrum, type Spectrum } from './util/eigenspectrum.ts';

// @public (P2) 组合·拓扑 — CRISPR 精确技能编辑（I-P2-4）+ 相变固化（I-P2-5）
export { CRISPRSkillEditor } from './adapters/skill/crisprSkillEditor.ts';
export type { CRISPRSkillEditorOptions } from './adapters/skill/crisprSkillEditor.ts';
export type {
  CRISPRSkillEditorPort,
  CrisprEditSpec,
  CrisprEditReport,
} from './ports/runtime/skillEdit.ts';
export { CapabilityCrystallizer } from './adapters/skill/capabilityCrystallizer.ts';
export type { CapabilityCrystallizerOptions } from './adapters/skill/capabilityCrystallizer.ts';
export type {
  CapabilityCrystallizerPort,
  CrystallizationReport,
  FrozenCapability,
} from './ports/intelligence/capability.ts';

// @public (P3) 高原创试点 — 刻蚀记忆 / 元素组合基元 / 对称破缺 / 禁闭色荷（I-P3-1~4）
export { InsightEtchingEngine } from './adapters/memory/insightEtchingEngine.ts';
export type { InsightEtchingOptions } from './adapters/memory/insightEtchingEngine.ts';
export type {
  InsightEtchingPort,
  EtchEvent,
  EtchTrace,
  EtchNode,
  EtchConduction,
  EtchBranch,
} from './ports/memory/insightEtching.ts';
export { ElementComposer } from './adapters/skill/elementComposer.ts';
export type {
  ElementComposerPort,
  ElementDef,
  CompoundCapability,
} from './ports/intelligence/elementComposer.ts';
export { SymmetryBreakingEngine } from './adapters/monitoring/symmetryBreakingEngine.ts';
export type { SymmetryBreakingOptions } from './adapters/monitoring/symmetryBreakingEngine.ts';
export type {
  SymmetryBreakingPort,
  SymmetryBreakReport,
  SymmetryState,
  UsageSample,
} from './ports/intelligence/symmetryBreaking.ts';
export { ConfinementEngine } from './adapters/monitoring/confinementEngine.ts';
export type { ConfinementOptions } from './adapters/monitoring/confinementEngine.ts';
export type {
  ConfinementPort,
  CapabilityCharge,
  BoundCapability,
  ConfinementVerdict,
  Charge,
} from './ports/runtime/confinement.ts';

// @public 进化闭环（P1：发现 → 评估 → 晋升，fail-closed）
export { FailClosedEvolutionGate } from './evolution/failClosedEvolutionGate.ts';
export type {
  BenchmarkFn,
  SafetyCheck,
  FailClosedEvolutionGateOptions,
} from './evolution/failClosedEvolutionGate.ts';
export { TwistDiscoveryEngine } from './evolution/twistDiscoveryEngine.ts';
export type { TwistDiscoveryOptions } from './evolution/twistDiscoveryEngine.ts';
export { EvolutionControllerImpl } from './evolution/evolutionControllerImpl.ts';
export { RlvrController } from './evolution/rlvrController.ts';
export type { RlvrEvolutionOptions, RlvrEvolutionBundle } from './evolution/rlvrController.ts';
export type { VerifiableRewardFn } from './evolution/verifiableReward.ts';
export { Benchmark } from './evolution/benchmark.ts';
export type {
  Candidate,
  PromotionVerdict,
  EvolutionGate,
  DiscoveryEngine,
  EvolutionController,
  EvolutionControllerOptions,
} from './ports/runtime/evolution.ts';
export { CodeInterpreter } from './adapters/tool/code/codeInterpreter.ts';
export type { CodeInterpreterDeps, CodeRunResult } from './adapters/tool/code/codeInterpreter.ts';
export { CodeExecutorTool } from './adapters/tool/code/codeExecutorTool.ts';
export type { CodeExecutorOptions } from './adapters/tool/code/codeExecutorTool.ts';

// @public Skills 系统
export type { Skill } from './skill/skill.ts';
export { SkillRegistry } from './skill/skillRegistry.ts';

// @public app-server / 协议
export { JsonRpc } from './server/core/jsonRpc.ts';
export type {
  RpcError,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from './server/core/jsonRpc.ts';
export { LineTransport } from './server/transport/lineTransport.ts';
export type { Transport } from './server/transport/lineTransport.ts';
export { AppServer } from './server/core/appServer.ts';
export type { AppServerOptions } from './server/core/appServer.ts';

// @public 单源 schema / SDK 生成
export { protocolSchema } from './schema/protocolSchema.ts';
export type {
  FieldSchema,
  FieldType,
  MethodSchema,
  ProtocolSchema,
} from './schema/protocolSchema.ts';
export { CodeGenerator } from './schema/codeGenerator.ts';

// @public 跨 harness worker 编排
export type { Worker, WorkerRequest, WorkerResult } from './worker/worker.ts';
export { CliWorker } from './worker/cliWorker.ts';
export type { CliWorkerOptions } from './worker/cliWorker.ts';
export { SimpleWorker } from './worker/simpleWorker.ts';
export { DshWorker } from './worker/dshWorker.ts';
export { WorkerRegistry } from './worker/workerRegistry.ts';
export { WorkerOrchestrator } from './worker/workerOrchestrator.ts';
export type { DelegateTask } from './worker/workerOrchestrator.ts';
export { DelegateTool } from './adapters/tool/workflow/delegateTool.ts';

// @public MCP 网关（对外暴露工具 / 桥接外部 MCP 服务器）
export { McpProtocol } from './mcp/mcpProtocol.ts';
export type {
  McpCallToolResult,
  McpCapabilities,
  McpInitializeResult,
  McpInputSchema,
  McpServerInfo,
  McpTextContent,
  McpToolDescriptor,
} from './mcp/mcpProtocol.ts';
export { McpToolMapper } from './mcp/mcpToolMapper.ts';
export { McpServer } from './mcp/mcpServer.ts';
export type { McpServerOptions } from './mcp/mcpServer.ts';
export { McpClient } from './mcp/mcpClient.ts';
export type { McpClientOptions } from './mcp/mcpClient.ts';
export { McpStdioTransport } from './mcp/mcpStdioTransport.ts';
export type { McpStdioHandle, McpStdioServerOptions } from './mcp/mcpStdioTransport.ts';
export { McpConnector } from './mcp/mcpConnector.ts';
export type { McpConnection, McpConnectorOptions } from './mcp/mcpConnector.ts';
export { McpGateway } from './mcp/mcpGateway.ts';
export type { McpBridgeResult, McpGatewayOptions, McpServerConfig } from './mcp/mcpGateway.ts';
export { McpServerCommand } from './mcp/mcpServerCommand.ts';

// @public 原生内核（FFI 下沉 #65：Node 进程内直调 Rust 内核，N-API / .node）
export { NativeKernel, NativeKernelUnavailableError } from './native/index.ts';
export type { NativeDecision } from './native/index.ts';
export { NativeBackend } from './native/index.ts';
export type { NativeToolRunner } from './native/index.ts';

// @public 企业管控（D2：SSO / 合规导出）
export { EnterpriseAuth, OidcClient } from './enterprise/index.ts';
export type {
  OidcProviderConfig,
  OidcDiscovery,
  PkcePair,
  TokenSet,
  Jwk,
  JwtParts,
  AuthState,
} from './enterprise/index.ts';
export { AuditExporter } from './server/services/auditExporter.ts';
export type { ComplianceReport, ComplianceReportMeta } from './server/services/auditExporter.ts';

// @public 版本契约（API 版本锚点，见 docs/API_STABILITY.md）
export { API_VERSION } from './version.ts';
export type { ApiVersion } from './version.ts';

// @public 长期运行遥测（P4, I-P4-3：回填基座 + 闭环参数收紧）
export { JsonlRuntimeTelemetry } from './adapters/telemetry/jsonlRuntimeTelemetry.ts';
export type { JsonlRuntimeTelemetryOptions } from './adapters/telemetry/jsonlRuntimeTelemetry.ts';
export type {
  RuntimeObservation,
  RuntimeTelemetryPort,
  TelemetryChainReport,
  TelemetryKind,
  TelemetryProvenance,
} from './ports/runtime/runtimeTelemetry.ts';

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
} from './genesis/index.ts';

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
} from './context/index.ts';
