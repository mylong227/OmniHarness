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
} from './ports/index.js';

// @public 核心
export { Agent } from './core/agent.js';
export type { AgentResult } from './core/agent.js';
export { AppendOnlyEventLog } from './core/eventLog.js';
export { Container } from './core/container.js';
export { createRuntime, ServiceKeys } from './core/runtime.js';
export type { OmniHarnessRuntime } from './core/runtime.js';
export { SessionRecorder } from './core/sessionRecorder.js';
export { StepRunner } from './core/stepRunner.js';
export { TurnRunner } from './core/turnRunner.js';

// @public 配置
export { ConfigFactory } from './config/omniharnessConfig.js';
export type { ExtraTool, OmniHarnessConfig } from './config/omniharnessConfig.js';
// 配置分层（#G6：多层合并 + profile 覆盖 + key 别名归一化 + 严格校验）
export { ConfigFile } from './config/configFile.js';
export type { FileConfig, FileMcpServer, LayeredOptions } from './config/configFile.js';
export { ProfileLoader } from './config/profile.js';
export {
  ConfigError,
  normalizeConfig,
  validateConfig,
  readEnvConfig,
  mergeConfigs,
} from './config/configLayer.js';

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
  isLikelySandboxDenied,
  classifyDenial,
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
} from './adapters/index.js';
export type { LiveBroadcaster } from './adapters/live/webLiveView.js';
export type { OpenAiCompatibleConfig } from './adapters/model/openaiCompatibleModel.js';
export { LlamaCppModel } from './adapters/model/llamaCppModel.js';
export type { LlamaCppConfig } from './adapters/model/llamaCppModel.js';
export {
  NetworkEgressGuard,
  EgressBlockedError,
  parseAllowList,
} from './adapters/sandbox/networkEgress.js';
export { DaemonController } from './daemon/daemon.js';
export { RoutineScheduler, matchesCron } from './daemon/routines.js';
export type { Routine, RoutineSchedule, RoutineModelAdapter } from './daemon/routines.js';
export { ResponsesModel } from './adapters/model/responsesModel.js';
export type { ResponsesConfig } from './adapters/model/responsesModel.js';
export {
  RetryingModel,
  isRetryable,
  DEFAULT_RETRY_POLICY,
} from './adapters/model/retryingModel.js';
export type { RetryPolicy, DelayFn } from './adapters/model/retryingModel.js';
export { BudgetedModel } from './adapters/model/budgetedModel.js';
export { CostBudget } from './adapters/model/costBudget.js';
export type { BudgetSnapshot } from './adapters/model/costBudget.js';
export {
  mergeRoutePricing,
  DEFAULT_ROUTE_PRICING,
  DEFAULT_FALLBACK_PRICE,
} from './adapters/model/routePricing.js';
export type { ToolHandler } from './adapters/tool/toolHandler.js';

// @public hooks 兼容层（codex-claude / claude-code 事件格式映射）
export { CodexHooksMapper } from './hooksCompat/codexHooks.js';
export { ClaudeCodeHooksMapper } from './hooksCompat/claudeCodeHooks.js';
export { HooksCompatAdapter } from './hooksCompat/hooksCompatAdapter.js';
export type { HookEventEnvelope, HookConsumer } from './hooksCompat/formats.js';

// @public 上下文 / 工具
export { ContextAssembler } from './context/contextAssembler.js';
export { TokenEstimator } from './context/tokenEstimator.js';
export { ContextCompactor } from './context/contextCompactor.js';
export type { CompactionOptions, CompactionResult } from './context/contextCompactor.js';
// Spill：超大工具输出外溢（#74）
export { SpillPolicy } from './context/spillPolicy.js';
export type { SpillPolicyOptions } from './context/spillPolicy.js';
export { ToolResultSpiller } from './context/toolResultSpiller.js';
export type { SpillerOptions } from './context/toolResultSpiller.js';
export { FileSpill } from './adapters/spill/fileSpill.js';
export { MemorySpill } from './adapters/spill/memorySpill.js';
export { SpillReadTool } from './adapters/tool/spillReadTool.js';
export { WorkspaceGuard, PathTraversalError } from './util/workspaceGuard.js';
export { OutputDecoder } from './util/outputDecoder.js';

// @public 插件系统（cordis-lite）
export { PluginManager } from './plugin/pluginManager.js';
export type { Plugin, PluginApplyContext, PluginMeta } from './plugin/plugin.js';
export { PermissionGate, PermissionDeniedError } from './plugin/permissionGate.js';
export type { PermissionDecision } from './plugin/permissionGate.js';
export type { PluginPermission } from './plugin/permission.js';
export { ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, isPluginPermission } from './plugin/permission.js';

// @public 门禁 / PTC 代码执行
export { ToolGate } from './core/toolGate.js';
export { SupervisorKernel } from './supervisor/supervisor.js';
export type {
  SupervisorPort,
  SupervisorOptions,
  SafeMode,
  HealthSnapshot,
  HealthEntry,
  AuditSinkLike,
} from './ports/supervisor.js';

// @public 燧-3 共振寻址 / 燧-4 涡环包（发明层 S+ 原语）
export { ResonantMemoryEngine } from './adapters/memory/resonantMemory.js';
export { VortexRingPacket, VortexRingSpillAdapter } from './adapters/spill/vortexRing.js';
export { SparkController } from './spark/sparkController.js';
export type { SparkCycleReport, SparkControllerOptions } from './spark/sparkController.js';
// @public (D) 热方程记忆重加权 / 退火调度（知识基础算子）
export { HeatEquationAnnealer } from './adapters/memory/heatAnnealer.js';
export type { HeatAnnealerOptions } from './adapters/memory/heatAnnealer.js';
export type { MemoryAnnealer, AnnealStepReport } from './ports/memoryAnnealing.js';
// @public (E) 宇宙网记忆 / QEC 记忆 / 免疫异常监控（发明层 S+ 原语，I-P1-2/3/5）
export { CosmicWebMemoryEngine } from './adapters/memory/cosmicWeb.js';
export type { CosmicWebOptions } from './adapters/memory/cosmicWeb.js';
export type { CosmicWebPort, WebConsolidationReport } from './ports/cosmicWeb.js';
export { QECEncoder } from './adapters/memory/qec.js';
export type { QECOptions } from './adapters/memory/qec.js';
export type { QECEncoderPort, QECStatus, QECReport } from './ports/qec.js';
export { ImmuneMonitor } from './adapters/monitoring/immuneMonitor.js';
export type { ImmuneMonitorOptions } from './adapters/monitoring/immuneMonitor.js';
export type { ImmuneMonitorPort, AnomalyAlert, ImmuneSelfReport } from './ports/immune.js';
// @public (P2) 信念·组合·拓扑 — 自然梯度信念 / 粒子滤波信念（I-P2-2/3，信息几何）
export { NaturalGradientBelief } from './adapters/belief/naturalGradient.js';
export type { NaturalGradientOptions } from './adapters/belief/naturalGradient.js';
export { ParticleFilterBelief } from './adapters/belief/particleFilter.js';
export type { ParticleFilterOptions } from './adapters/belief/particleFilter.js';
export type {
  MetacognitionPort,
  BeliefSnapshot,
  BeliefUpdateReport,
  BeliefKlComponent,
} from './ports/metacognition.js';
export {
  eigenSpectrum,
  spectrumFromValues,
  resonance,
  type Spectrum,
} from './util/eigenspectrum.js';

// @public (P2) 组合·拓扑 — CRISPR 精确技能编辑（I-P2-4）+ 相变固化（I-P2-5）
export { CRISPRSkillEditor } from './adapters/skill/crispr.js';
export type { CRISPRSkillEditorOptions } from './adapters/skill/crispr.js';
export type { CRISPRSkillEditorPort, CrisprEditSpec, CrisprEditReport } from './ports/skillEdit.js';
export { CapabilityCrystallizer } from './adapters/skill/capabilityCrystallizer.js';
export type { CapabilityCrystallizerOptions } from './adapters/skill/capabilityCrystallizer.js';
export type {
  CapabilityCrystallizerPort,
  CrystallizationReport,
  FrozenCapability,
} from './ports/capability.js';

// @public (P3) 高原创试点 — 刻蚀记忆 / 元素组合基元 / 对称破缺 / 禁闭色荷（I-P3-1~4）
export { InsightEtchingEngine } from './adapters/memory/insightEtching.js';
export type { InsightEtchingOptions } from './adapters/memory/insightEtching.js';
export type {
  InsightEtchingPort,
  EtchEvent,
  EtchTrace,
  EtchNode,
  EtchConduction,
  EtchBranch,
} from './ports/insightEtching.js';
export { ElementComposer } from './adapters/skill/elementComposer.js';
export type {
  ElementComposerPort,
  ElementDef,
  CompoundCapability,
} from './ports/elementComposer.js';
export { SymmetryBreakingEngine } from './adapters/monitoring/symmetryBreaking.js';
export type { SymmetryBreakingOptions } from './adapters/monitoring/symmetryBreaking.js';
export type {
  SymmetryBreakingPort,
  SymmetryBreakReport,
  SymmetryState,
  UsageSample,
} from './ports/symmetryBreaking.js';
export { ConfinementEngine } from './adapters/monitoring/confinement.js';
export type { ConfinementOptions } from './adapters/monitoring/confinement.js';
export type {
  ConfinementPort,
  CapabilityCharge,
  BoundCapability,
  ConfinementVerdict,
  Charge,
} from './ports/confinement.js';

// @public 进化闭环（P1：发现 → 评估 → 晋升，fail-closed）
export { FailClosedEvolutionGate } from './evolution/evolutionGate.js';
export type {
  Benchmark,
  SafetyCheck,
  FailClosedEvolutionGateOptions,
} from './evolution/evolutionGate.js';
export { TwistDiscoveryEngine } from './evolution/discoveryEngine.js';
export type { TwistDiscoveryOptions } from './evolution/discoveryEngine.js';
export { EvolutionControllerImpl, createEvolutionController } from './evolution/controller.js';
export { createRlvrEvolutionController } from './evolution/rlvrController.js';
export type { RlvrEvolutionOptions, RlvrEvolutionBundle } from './evolution/rlvrController.js';
export {
  verifiableRewardForCode,
  verifiableRewardFromCommand,
  verifiableRewardFromEvalRunner,
  createVerifiableGate,
} from './evolution/verifiableReward.js';
export {
  capabilityCoverage,
  jointProfile,
  fieldMatch,
  moireEnergy,
} from './evolution/benchmark.js';
export type {
  Candidate,
  PromotionVerdict,
  EvolutionGate,
  DiscoveryEngine,
  EvolutionController,
  EvolutionControllerOptions,
} from './ports/evolution.js';
export { CodeInterpreter } from './code/codeInterpreter.js';
export type { CodeInterpreterDeps, CodeRunResult } from './code/codeInterpreter.js';
export { CodeExecutorTool } from './code/codeExecutorTool.js';
export type { CodeExecutorOptions } from './code/codeExecutorTool.js';

// @public Skills 系统
export type { Skill } from './skill/skill.js';
export { SkillRegistry } from './skill/skillRegistry.js';

// @public app-server / 协议
export { JsonRpc } from './server/jsonRpc.js';
export type {
  RpcError,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from './server/jsonRpc.js';
export { LineTransport } from './server/lineTransport.js';
export type { Transport } from './server/lineTransport.js';
export { AppServer } from './server/appServer.js';
export type { AppServerOptions } from './server/appServer.js';

// @public 单源 schema / SDK 生成
export { protocolSchema } from './schema/protocolSchema.js';
export type {
  FieldSchema,
  FieldType,
  MethodSchema,
  ProtocolSchema,
} from './schema/protocolSchema.js';
export { CodeGenerator } from './schema/codeGenerator.js';

// @public 跨 harness worker 编排
export type { Worker, WorkerRequest, WorkerResult } from './worker/worker.js';
export { CliWorker } from './worker/cliWorker.js';
export type { CliWorkerOptions } from './worker/cliWorker.js';
export { SimpleWorker } from './worker/simpleWorker.js';
export { DshWorker } from './worker/dshWorker.js';
export { WorkerRegistry } from './worker/workerRegistry.js';
export { WorkerOrchestrator } from './worker/workerOrchestrator.js';
export type { DelegateTask } from './worker/workerOrchestrator.js';
export { DelegateTool } from './adapters/tool/delegateTool.js';

// @public MCP 网关（对外暴露工具 / 桥接外部 MCP 服务器）
export { McpProtocol } from './mcp/mcpProtocol.js';
export type {
  McpCallToolResult,
  McpCapabilities,
  McpInitializeResult,
  McpInputSchema,
  McpServerInfo,
  McpTextContent,
  McpToolDescriptor,
} from './mcp/mcpProtocol.js';
export { McpToolMapper } from './mcp/mcpToolMapper.js';
export { McpServer } from './mcp/mcpServer.js';
export type { McpServerOptions } from './mcp/mcpServer.js';
export { McpClient } from './mcp/mcpClient.js';
export type { McpClientOptions } from './mcp/mcpClient.js';
export { McpStdioTransport } from './mcp/mcpStdioTransport.js';
export type { McpStdioHandle, McpStdioServerOptions } from './mcp/mcpStdioTransport.js';
export { McpConnector } from './mcp/mcpConnector.js';
export type { McpConnection, McpConnectorOptions } from './mcp/mcpConnector.js';
export { McpGateway } from './mcp/mcpGateway.js';
export type { McpBridgeResult, McpGatewayOptions, McpServerConfig } from './mcp/mcpGateway.js';
export { formatBridgeResults, parseMcpServerSpec } from './mcp/mcpServerCommand.js';

// @public 原生内核（FFI 下沉 #65：Node 进程内直调 Rust 内核，N-API / .node）
export { NativeKernel, NativeKernelUnavailableError } from './native/index.js';
export type { NativeDecision } from './native/index.js';
export { NativeBackend } from './native/index.js';
export type { NativeToolRunner } from './native/index.js';

// @public 企业管控（D2：SSO / 合规导出）
export {
  EnterpriseAuth,
  fetchDiscovery,
  generatePkcePair,
  buildAuthorizationUrl,
  exchangeCode,
  decodeJwt,
  verifyIdTokenClaims,
  verifyJwtSignature,
  writeAuthState,
  readAuthState,
} from './enterprise/index.js';
export type {
  OidcProviderConfig,
  OidcDiscovery,
  PkcePair,
  TokenSet,
  Jwk,
  JwtParts,
  AuthState,
} from './enterprise/index.js';
export { buildComplianceReport, formatCompliance } from './server/auditExport.js';
export type { ComplianceReport, ComplianceReportMeta } from './server/auditExport.js';

// @public 版本契约（API 版本锚点，见 docs/API_STABILITY.md）
export { API_VERSION } from './version.js';
export type { ApiVersion } from './version.js';

// @public 长期运行遥测（P4, I-P4-3：回填基座 + 闭环参数收紧）
export { JsonlRuntimeTelemetry } from './adapters/telemetry/jsonlRuntimeTelemetry.js';
export type { JsonlRuntimeTelemetryOptions } from './adapters/telemetry/jsonlRuntimeTelemetry.js';
export type {
  RuntimeObservation,
  RuntimeTelemetryPort,
  TelemetryChainReport,
  TelemetryKind,
  TelemetryProvenance,
} from './ports/runtimeTelemetry.js';

// @public 太初数学内核（Genesis Core）：可推演代数态射 + 多模态 + 自适应
// 统一内核——把能耗/成本建模为交换幺半群、算子的指称语义、能量守恒账本、
// 多模态函子（原生支持多模态）、按工况重配置管线的收敛型自适应控制器。
export {
  emptyCost,
  cost,
  concatCost,
  costMonoid,
  JOULES_PER_TOKEN_ESTIMATE,
  vectorConcat,
  vectorEmpty,
  dot,
  norm,
  cosine,
  shannon,
  type Cost,
  type Semigroup,
  type Monoid,
  encodeText,
  encodeImage,
  mapModality,
  fuseModality,
  alignModality,
  textFeatures,
  imageFeatures,
  type Modality,
  type ModalityKind,
  identityOperator,
  composeOperator,
  operatorMonoid,
  liftOperator,
  liftCosted,
  type Operator,
  type OperatorResult,
  Ledger,
  sumCosts,
  deriveEntropy,
  characteristicRegime,
  fuseOperator,
  pruneOperator,
  plan,
  adaptOnce,
  type GenesisState,
  type Regime,
} from './genesis/index.js';

// @public 上下文效率层（自研 · 零依赖）：确定性压缩 + 前缀稳定性治理（KV 缓存命中率根因变量）
export {
  canonicalize,
  stableStringify,
  scrubVolatile,
  commonPrefixLength,
  prefixReuse,
  buildStablePrompt,
  reorderDeterministic,
  injectVolatile,
  jitterSegments,
  measurePrefixStability,
  type PromptSegment,
  type PromptBuildOptions,
  type PrefixStabilityReport,
  byteLength,
  type SegmentKind,
  type ContextSegment,
  type CompressOptions,
  type CompressStageMetric,
  type CompressReport,
  type CompressResult,
  collapseBlankLines,
  minifyJsonBlock,
  truncateLongOutput,
  deduplicateSegments,
  foldHistorySegments,
  compressContext,
} from './context/index.js';
