import { SsrfGuard, type SsrfOptions } from '../security/ssrfGuard.js';
import type { ResolvedConfig } from '../config/configFactory.js';
import { NativeBackend } from '../native/nativeBackend.js';
import { MUTATING_TOOLS, ToolGate } from '../core/toolGate.js';
import { SupervisorKernel } from '../supervisor/supervisorKernel.js';
import type { SupervisorPort } from '../ports/runtime/supervisor.js';
import type { EvolutionController } from '../ports/runtime/evolution.js';
import { Container } from '../core/container.js';
import { RlvrController } from '../evolution/rlvrController.js';
import { A2aTaskExecutor } from '../a2a/a2aTaskExecutor.js';
import { TurnCompletionGateFactory } from '../adapters/tool/verify/turnCompletionGateFactory.js';
import {
  A2aServer,
  A2aClient,
  HttpA2aTransport,
  HttpA2aServerTransport,
  WsA2aTransport,
  WsA2aServerTransport,
} from '../a2a/index.js';
import type { A2aTransport } from '../a2a/a2aProtocol.js';
import { ServiceKeys } from './serviceKeys.js';
import { SsrfPolicy } from '../security/ssrfPolicy.js';

/**
 * Runtime —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class Runtime {
  /**
   * 由配置装配出运行时。
   * 注：`supervisor` 为可选覆盖项（不属 ResolvedConfig 持久字段）：传入则用之，否则默认构造生产级
   * SupervisorKernel。eval / 基准 harness 可传 no-op 监督内核以纯测 agent 能力、剥离生产安全降级噪声。
   *
   * 注意：live / embedding 默认值（ConsoleLiveView 组合视图、本地 ONNX 嵌入适配器）由组合根
   * `ConfigFactory.build` 装配注入，本函数不再直接 import adapters（保持 core 层零适配器依赖）。
   */
  public static createRuntime(
    config: ResolvedConfig & { supervisor?: SupervisorPort },
  ): OmniHarnessRuntime {
    const container = new Container();
    container.register(ServiceKeys.model, config.model);
    container.register(ServiceKeys.tools, config.tools);
    container.register(ServiceKeys.storage, config.storage);
    container.register(ServiceKeys.events, config.events);
    container.register(ServiceKeys.sandbox, config.sandbox);
    container.register(ServiceKeys.approvals, config.approvals);
    const supervisor =
      config.supervisor ?? new SupervisorKernel({ hazardousTools: MUTATING_TOOLS });
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
        ? RlvrController.createRlvrEvolutionController({
            skills: config.skillRegistry.list(),
            compose: (a, b, o) => config.skillRegistry.composeByTwist(a, b, o),
            model: config.model,
            maxCandidates: config.evolutionRlvr.maxCandidates,
            samplesPerPrompt: config.evolutionRlvr.samplesPerPrompt,
            minReward: config.evolutionRlvr.minReward,
            verifyCommand: config.evolutionRlvr.verifyCommand,
            verifyCodeFileExtension: config.evolutionRlvr.verifyCodeFileExtension,
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
      // P5 自动降档：预算计量桥成的只读端口，透传给 StepRunnerDeps（core 消费点）。
      budgetDegrade: config.budgetDegrade,
      // A1 回合完成闸门：组合根注入实现（core 只认端口 `CompletionGateFactory`），口径见其模块头。
      completionGateFactory: (ctx) => TurnCompletionGateFactory.of(ctx),
    } as OmniHarnessRuntime;
    Runtime.attachA2a(runtime, config);
    return runtime;
  }

  /**
   * U6 A2A 互操作接线：启用时实例化 server（监听）+ client，server 任务处理器跑子 agent 完成对等委托。
   * 能力胶囊 = Ed25519 签名即身份（fail-closed 验签），复用 config.identity + 子 agent 隔离运行时。
   * 抽成独立方法：`createRuntime` 已贴近 AST 体量门禁基线（不得再长）。
   * @param runtime 已装配的运行时（就地为 `a2a` 字段赋值）。
   * @param config 已解析配置（读取 `a2a` / `identity`）。
   * @returns 无返回值。
   */
  private static attachA2a(runtime: OmniHarnessRuntime, config: ResolvedConfig): void {
    if (config.a2a?.enabled !== true) {
      return;
    }
    const a2aPort = config.a2a.port ?? 8790;
    // 传输形态：http（默认，POST /a2a）或 ws（RFC6455，/a2a-ws）。二者实现同一 A2aTransport 端口，
    // 协议与门禁完全共用；缺省 http 保持原行为（零破坏）。
    const wsMode = config.a2a.transport === 'ws';
    const serverTransport = wsMode ? new WsA2aServerTransport() : new HttpA2aServerTransport();
    const server = new A2aServer(serverTransport, config.identity);
    const peer =
      config.a2a.peerEndpoint ??
      (wsMode ? `ws://localhost:${a2aPort}/a2a-ws` : `http://localhost:${a2aPort}/a2a`);
    const client = new A2aClient(makeA2aTransport(peer, wsMode, config), config.identity);
    // 委托执行器：并发闸门 + 受限工具子集（剔除 MUTATING_TOOLS，若委托声明 tools 授权则取交集），
    // 复用既有子代理隔离运行时，避免对等方突发委托拖垮进程或越权调用写类工具。
    const executor = new A2aTaskExecutor(runtime);
    server.setTaskHandler(executor);
    void serverTransport.listen(a2aPort);
    runtime.a2a = { server, client, transport: serverTransport };
  }
}

// 保持既有公共 API：`ServiceKeys` 定义已下沉到 `./serviceKeys.js`（为打断组合根↔子代理的真值环），
// 此处再导出，使 `src/index.ts` 等既有调用点零改动。
export { ServiceKeys };
import type { OmniHarnessRuntime } from '../ports/composition/omniHarnessRuntime.js';
export type { OmniHarnessRuntime };

/** OmniHarness运行时：装配全部端口 + 注册进容器（供自定义扩展查询）。 */

/**
 * 构造 A2A 客户端传输（http / ws 实现同一 `A2aTransport` 端口），并注入 SSRF 选项：
 * 默认档（含 `allowPrivate`，兼容本地端点）+ 配置化策略表（配置文件 → CLI → 此处）。
 * 抽成模块级而非内联：两分支需同一份选项，且 `createRuntime` 已贴近 AST 体量门禁基线（不得再长）。
 * @param peer 对端端点（显式配置或由 `wsMode` 推出的本地回环地址）
 * @param wsMode 是否走 WebSocket（false ⇒ HTTP `POST /a2a`）
 * @param config 已解析配置（读取 `ssrfPolicy`）
 * @returns A2A 客户端传输实现
 */
const makeA2aTransport = (peer: string, wsMode: boolean, config: ResolvedConfig): A2aTransport => {
  const ssrf: SsrfOptions = SsrfGuard.ssrfOptionsFor(
    SsrfPolicy.resolveSsrfPolicy(config.ssrfPolicy),
  );
  return wsMode ? new WsA2aTransport(peer, ssrf) : new HttpA2aTransport(peer, ssrf);
};
