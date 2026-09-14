import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { ModelPort } from '../ports/model/model.js';
import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { StoragePort } from '../ports/memory/storage.js';
import type { RetrievalPort } from '../ports/intelligence/retrieval.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import type { CosmicWebPort } from '../ports/memory/cosmicWeb.js';
import type { MemoryExtractorPort } from '../ports/memory/memoryExtractor.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';
import type { ToolPort } from '../ports/tool/tool.js';
import type { ResolvedConfig } from '../config/configFactory.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import type { ToolDiscovery } from '../search/toolDiscovery.js';
import type { NativeToolRunner } from '../native/nativeBackend.js';
import { NativeBackend } from '../native/nativeBackend.js';
import type { ToolInputSink } from '../ports/tool/toolInputSink.js';
import type { EmbeddingPort } from '../ports/model/embedding.js';
import { MUTATING_TOOLS, ToolGate } from './toolGate.js';
import { SupervisorKernel } from '../supervisor/supervisorKernel.js';
import type { SupervisorPort } from '../ports/runtime/supervisor.js';
import { Container } from './container.js';
import type { TurnDiffTracker } from './turnDiffTracker.js';
import type { ToolHookRunner } from './toolHookRunner.js';
import type { EvolutionController } from '../ports/runtime/evolution.js';
import { createRlvrEvolutionController } from '../evolution/rlvrController.js';
import type { SparkController } from '../spark/sparkController.js';
import { subagentRuntimeFactory } from '../subagent/subagentRuntimeFactory.js';
import { portsOf } from '../subagent/subagentPorts.js';
import { Agent } from './agent.js';
import {
  A2aServer,
  A2aClient,
  HttpA2aTransport,
  HttpA2aServerTransport,
  WsA2aTransport,
  WsA2aServerTransport,
} from '../a2a/index.js';
import type { A2aTransport } from '../a2a/a2aProtocol.js';

/** 端口服务键（容器内标准键名）。 */
export const ServiceKeys = {
  model: 'port.model',
  tools: 'port.tools',
  storage: 'port.storage',
  events: 'port.events',
  sandbox: 'port.sandbox',
  approvals: 'port.approvals',
} as const;

/** OmniHarness运行时：装配全部端口 + 注册进容器（供自定义扩展查询）。 */
export interface OmniHarnessRuntime {
  readonly config: ResolvedConfig;
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly storage: StoragePort;
  readonly events: EventPort;
  readonly sandbox: SandboxPort;
  readonly approvals: ApprovalPort;
  /** 升级审批端口（#G3/G4）：沙箱拒绝时咨询，决定是否提权重试。 */
  readonly escalation: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，默认无沙箱）：escalate 裁决后以此复核放行。 */
  readonly elevatedSandbox: SandboxPort;
  /** 统一门禁（审批 + 沙箱 + 计划态，#77 计划门禁在此生效）：StepRunner 与 run_code 共用。 */
  readonly gate: ToolGate;
  /** 航天级监督内核（I-P0-3）：健康监控 + Safe mode 分级降级，运行时装配注入主循环。 */
  readonly supervisor?: SupervisorPort | undefined;
  /** 工具结果外溢器（#74）：超大输出落后端，只留有界预览。 */
  readonly spiller: ToolResultSpiller;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，StepRunner 据此装载延迟加载工具。 */
  readonly discovery: ToolDiscovery;
  /** 检索端口（#M2）：会话历史事件索引供 memory_search 检索，实现跨长对话 recall。 */
  readonly retrieval: RetrievalPort;
  /** 回合级变更追踪器（#M5）：回合结束时产出 unified diff；关闭时为 undefined。 */
  readonly turnDiff?: TurnDiffTracker | undefined;
  /** 工具钩子运行器（#M5）：变更追踪钩子在此注册，由 StepRunner 执行。 */
  readonly hooks?: ToolHookRunner | undefined;
  /** 长期记忆端口（#S28）：跨会话持久 fact 存储，recall 工具与回合末蒸馏共用。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** 宇宙网记忆引擎（U1 默认开时为 ResonantFieldEngine 单一状态源，实现 CosmicWebPort）：供 runtime 直接驱动 consolidate。 */
  readonly web?: CosmicWebPort | undefined;
  /** 长期记忆蒸馏器（#S28，可选）：模型存在且未关自动沉淀时非空，回合末由 TurnRunner 调用。 */
  readonly memoryExtractor?: MemoryExtractorPort | undefined;
  readonly container: Container;
  /** 原生后端（FFI #66）：非空时工具执行路由到 Rust 内核；内核不可用则置空以回退 TS 路径。 */
  readonly native?: NativeToolRunner | undefined;
  /**
   * 工具输入实时观察端口（#B3）：模型流式生成的工具参数增量经此端口推给 UI。
   * 可选；子代理等不需实时渲染的场景留空（undefined → StepRunner 走 generate 路径）。
   */
  readonly live?: ToolInputSink | undefined;
  /**
   * 语义嵌入端口（U3 混合检索，可选）：注入后 repo-map 走「BM25 ∪ 语义向量 RRF」混合路径。
   * 由 ConfigFactory 在 env OMNI_SEMANTIC_RECALL=1 时构造并注入；默认 undefined（纯 BM25、零开销）。
   */
  readonly embedding?: EmbeddingPort | undefined;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省 undefined，零破坏。 */
  readonly evolution?: EvolutionController | undefined;
  /** 燧内核控制器（S+，可选）：任一燧能力启用时构造，Agent 任务末跑 燧-3/燧-4 调谐/冲刷；缺省 undefined，零破坏。 */
  readonly spark?: SparkController | undefined;
  /** (U6) A2A 互操作：启用时本端起 A2aServer（监听）并构造 A2aClient，server 任务处理器跑子 agent 完成对等委托。缺省 undefined，零破坏。 */
  a2a?: {
    readonly server: A2aServer;
    readonly client: A2aClient;
    readonly transport: A2aTransport;
  };
}

/**
 * 由配置装配出运行时。
 * 注：`supervisor` 为可选覆盖项（不属 ResolvedConfig 持久字段）：传入则用之，否则默认构造生产级
 * SupervisorKernel。eval / 基准 harness 可传 no-op 监督内核以纯测 agent 能力、剥离生产安全降级噪声。
 *
 * 注意：live / embedding 默认值（ConsoleLiveView 组合视图、本地 ONNX 嵌入适配器）由组合根
 * `ConfigFactory.build` 装配注入，本函数不再直接 import adapters（保持 core 层零适配器依赖）。
 */
export function createRuntime(
  config: ResolvedConfig & { supervisor?: SupervisorPort },
): OmniHarnessRuntime {
  const container = new Container();
  container.register(ServiceKeys.model, config.model);
  container.register(ServiceKeys.tools, config.tools);
  container.register(ServiceKeys.storage, config.storage);
  container.register(ServiceKeys.events, config.events);
  container.register(ServiceKeys.sandbox, config.sandbox);
  container.register(ServiceKeys.approvals, config.approvals);
  const supervisor = config.supervisor ?? new SupervisorKernel({ hazardousTools: MUTATING_TOOLS });
  const gate = new ToolGate(
    config.approvals,
    config.sandbox,
    config.plan,
    config.planMode,
    config.escalation,
    config.elevatedSandbox,
    supervisor,
  );
  // U4 RLVR 进化闭环：启用时构造「可验证门禁 + RLVR sample-filter-replay」控制器并赋给 runtime.evolution，
  // 取代/补充 config.evolution 注入。发现用 skillRegistry 的燧-1 组合，门禁默认 capabilityCoverage 基准，
  // RLVR 奖励来自候选代码真实编译/测试绿度。缺省关，零破坏；skillRegistry 缺失则回退 config.evolution。
  const evolutionController: EvolutionController | undefined =
    config.evolutionRlvr?.enabled === true && config.skillRegistry !== undefined
      ? createRlvrEvolutionController({
          skills: config.skillRegistry.list(),
          compose: (a, b, o) => config.skillRegistry.composeByTwist(a, b, o),
          model: config.model,
          maxCandidates: config.evolutionRlvr.maxCandidates,
          samplesPerPrompt: config.evolutionRlvr.samplesPerPrompt,
          minReward: config.evolutionRlvr.minReward,
          verifyCommand: config.evolutionRlvr.verifyCommand,
          minGain: config.evolutionRlvr.minGain,
          autoRun: config.evolutionRlvr.autoRun === true,
        }).controller
      : config.evolution;
  const runtime: OmniHarnessRuntime = {
    config,
    model: config.model,
    tools: config.tools,
    storage: config.storage,
    events: config.events,
    sandbox: config.sandbox,
    approvals: config.approvals,
    escalation: config.escalation,
    elevatedSandbox: config.elevatedSandbox,
    gate,
    supervisor,
    spiller: config.spiller,
    discovery: config.discovery,
    retrieval: config.retrieval,
    container,
    native: config.native ? NativeBackend.tryCreate() : undefined,
    turnDiff: config.turnDiffTracker,
    hooks: config.hooks,
    longTermMemory: config.longTermMemory,
    web: config.web,
    memoryExtractor: config.memoryExtractor,
    // #B3 web：live 默认组合视图由 ConfigFactory 装配（内置 ConsoleLiveView，TTY 实时刷新）；
    // serve 模式下 CLI 再注入 WebLiveView 广播给 Web UI，实现同一份增量多端呈现。
    // config.live 非空则优先（用户自定义则仅用其，绕过内置组合）。
    live: config.live,
    // U3 混合检索：env OMNI_SEMANTIC_RECALL=1 时由 ConfigFactory 构造本地 ONNX 嵌入适配器
    // （懒加载，首次 embed 才下载模型），结果经 config.embedding 注入。缺省 undefined → 纯 BM25，零破坏、零开销。
    embedding: config.embedding,
    evolution: evolutionController,
    spark: config.spark,
  } as OmniHarnessRuntime;
  // U6 A2A 互操作：启用时实例化 server（监听）+ client，server 任务处理器跑子 agent 完成对等委托。
  // 能力胶囊 = Ed25519 签名即身份（fail-closed 验签），复用 config.identity + 子 agent 隔离运行时。
  if (config.a2a?.enabled === true) {
    const a2aPort = config.a2a.port ?? 8790;
    // 传输形态：http（默认，POST /a2a）或 ws（RFC6455，/a2a-ws）。二者实现同一 A2aTransport 端口，
    // 协议与门禁完全共用；缺省 http 保持原行为（零破坏）。
    const wsMode = config.a2a.transport === 'ws';
    const serverTransport = wsMode ? new WsA2aServerTransport() : new HttpA2aServerTransport();
    const server = new A2aServer(serverTransport, config.identity);
    const peer =
      config.a2a.peerEndpoint ??
      (wsMode ? `ws://localhost:${a2aPort}/a2a-ws` : `http://localhost:${a2aPort}/a2a`);
    const client = new A2aClient(
      wsMode ? new WsA2aTransport(peer) : new HttpA2aTransport(peer),
      config.identity,
    );
    server.setTaskHandler({
      async handle(req) {
        const start = Date.now();
        try {
          const sub = subagentRuntimeFactory.build(
            portsOf(runtime),
            runtime.tools,
            runtime.events,
            runtime.config.maxSteps,
          );
          const result = await new Agent(sub).runTask(req.task);
          return {
            ok: true,
            output: result.finalText ?? '',
            steps: result.steps,
            durationMs: Date.now() - start,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, output: '', steps: 0, durationMs: Date.now() - start, error: msg };
        }
      },
    });
    void serverTransport.listen(a2aPort);
    runtime.a2a = { server, client, transport: serverTransport };
  }
  return runtime;
}
