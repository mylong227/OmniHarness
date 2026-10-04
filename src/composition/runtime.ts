import { SsrfGuard, type SsrfOptions } from '../security/ssrfGuard.js';

import { NativeBackend } from '../native/nativeBackend.js';
import { MUTATING_TOOLS, ToolGate } from '../core/toolGate.js';
import { SupervisorKernel } from '../supervisor/supervisorKernel.js';
import type { SupervisorPort } from '../ports/runtime/supervisor.js';
import type { EvolutionController } from '../ports/runtime/evolution.js';
import { Container } from '../core/container.js';
import { RlvrController } from '../evolution/rlvrController.js';
import { EvolutionKernel } from '../evolution/evolutionKernel.js';
import { EvolutionSignalCollector } from '../evolution/evolutionSignalCollector.js';
import { BucketedCandidateArchive } from '../evolution/bucketedCandidateArchive.js';
import { EliteReentryDiscovery } from '../evolution/eliteReentryDiscovery.js';
import { HashChainPromotionLedger } from '../evolution/hashChainPromotionLedger.js';
import { TwistDiscoveryEngine } from '../evolution/twistDiscoveryEngine.js';
import { MoireComposer } from '../skill/moireComposer.js';
import { SkillRegistry } from '../skill/skillRegistry.js';
import type { Skill, MoireOptions } from '../skill/skill.js';
import type { PromotionLedgerPort, SkillRestorePlan } from '../ports/runtime/evolution.js';
import { join } from 'node:path';
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
import { log } from '../util/logger.js';

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
    // （GEE Kernel v1）`evolutionRlvr.kernel === true` 时改走 EvolutionKernel 七环编排（ADR-0008）：
    // 信号 → 档案 → 级联 → 门禁 → 台账 → 晋升 → 观测；实现同一 EvolutionController 端口，关掉即回本路径。
    const evolutionController: EvolutionController | undefined =
      config.evolutionRlvr?.enabled === true && config.skillRegistry !== undefined
        ? config.evolutionRlvr.kernel === true
          ? Runtime.assembleKernelEvolution(config)
          : RlvrController.createRlvrEvolutionController({
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
              // 晋升回调接线（2026-10-01 审计）：进化闭环的前六环（发现 / RLVR 可验证奖励 /
              // fail-closed 门禁 / 退火接受 / 多样性保留 / 覆盖率闸）都是真实现，唯独 `onPromote`
              // 在生产装配里从未传入 —— 于是「评估通过」之后什么都不发生，闭环断在最后一米，
              // 只写一行 `evolution.cycle` 日志。此处把晋升真正落进技能注册表，使晋升后的技能
              // 能被主循环的技能稀疏化器（`agent.ts` 的 SkillSparsifier）选中并注入上下文。
              onPromote: (candidate) => {
                const registry = config.skillRegistry;
                if (registry === undefined) {
                  return;
                }
                // 用 `replace` 而非 `register`：候选在「莫尔转角组合」阶段可能已入册，
                // 重复 `register` 会抛「技能重复注册」，反把一次合法晋升变成运行时异常。
                registry.replace(candidate.skill);
                log.info('evolution.promoted', {
                  skill: candidate.skill.name,
                  source: candidate.source,
                });
              },
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
   * （GEE Kernel v1 · ADR-0008）Kernel 路径装配：七环编排器 + 复合发现引擎（精英重入 + 实读技能源）。
   *
   * 关键点：
   * - 内层 RLVR 控制器**不传 `onPromote`**——晋升裁决流出后由 Kernel 统一执行
   *   「快照（S3 起）→ 晋升 → 档案退役」的治理尾巴，晋升路径只有一个入口；
   * - 信号源接 `config.runtimeTelemetry`（production 观测行 → 失败挖掘 / 成功密度）；
   * - 固化器复用 `config.crystallizer`（`capabilityCrystallization.enabled` 时构造），
   *   与燧内核共用同一实例——「编辑—固化—观测」面对同一份技能状态。
   *
   * @param config 已解析配置（读 `evolutionRlvr` / `skillRegistry` / `runtimeTelemetry` / `crystallizer`）
   * @returns Kernel 进化控制器（调用方已保证 skillRegistry 非空）
   */
  private static assembleKernelEvolution(config: ResolvedConfig): EvolutionController {
    const registry = config.skillRegistry;
    const rlvr = config.evolutionRlvr;
    // Kernel 路径用**纯函数**组合器（不自动注册）：候选是待裁决对象，只有走完
    // ring ⑤⑥（快照 → 晋升）才进注册表——现状路径的 `registry.composeByTwist` 会在
    // 门禁之前就把组合产物入册（其既有属性），与「无快照不晋升」的治理语义相抵。
    const compose = (a: Skill, b: Skill, o?: MoireOptions): Skill =>
      MoireComposer.composeByTwist(a, b, o);
    const archive = new BucketedCandidateArchive({
      maxPerBucket: rlvr?.archiveMaxPerBucket,
    });
    const reentry = new EliteReentryDiscovery({
      inner: new TwistDiscoveryEngine({
        skills: () => registry.list(),
        compose,
        maxCandidates: rlvr?.maxCandidates ?? 12,
      }),
    });
    const bundle = RlvrController.createRlvrEvolutionController({
      skills: registry.list(),
      compose,
      model: config.model,
      maxCandidates: rlvr?.maxCandidates,
      samplesPerPrompt: rlvr?.samplesPerPrompt,
      minReward: rlvr?.minReward,
      verifyCommand: rlvr?.verifyCommand,
      verifyCodeFileExtension: rlvr?.verifyCodeFileExtension,
      minGain: rlvr?.minGain,
      autoRun: rlvr?.autoRun === true,
      discovery: reentry,
      // S4 级联评估：静态预检先于 verifyCommand（成本优化只在 Kernel 路径开；
      // kernel:off 路径保持逐行为等价——见 RlvrEvolutionOptions.cascade 的「缺省关」口径）。
      cascade: true,
      // S5 覆盖率分桶：覆盖率闸取最差工况桶（同上，只在 Kernel 路径开）。
      bucketedCoverage: true,
    });
    // 晋升台账（ring ⑤）：落盘 `<workspace>/<ledgerDir>/ledger.jsonl`（默认 `.omniharness/evolution`）。
    // 载入即全链验签：断链/不可用的台账视同缺失（kernel 对缺台账 fail-closed：无快照不晋升）。
    const ledgerDir = join(config.workspaceRoot, rlvr?.ledgerDir ?? '.omniharness/evolution');
    let ledger: PromotionLedgerPort | undefined;
    try {
      const candidate = new HashChainPromotionLedger({ dir: ledgerDir });
      ledger = candidate.verify().ok ? candidate : undefined;
    } catch (err) {
      log.warn('evolution.kernel.ledger.unusable', { dir: ledgerDir, error: String(err) });
    }
    if (ledger === undefined) {
      log.warn('evolution.kernel.ledger.unusable', {
        dir: ledgerDir,
        invariant: '断链/不可用台账视同缺失：无快照不晋升（fail-closed）',
      });
    }
    return new EvolutionKernel({
      inner: bundle.controller,
      signals: new EvolutionSignalCollector({ telemetry: config.runtimeTelemetry }),
      archive,
      reentry,
      crystallizer: config.crystallizer,
      ledger,
      skillsProvider: () => registry.list(),
      applyRestore: (plan) => Runtime.applySkillRestore(registry, plan),
      onPromote: (candidate) => {
        // 用 `replace` 而非 `register`：候选在组合阶段可能已入册，重复注册会抛运行时异常（口径同现状路径）。
        registry.replace(candidate.skill);
        log.info('evolution.promoted', {
          skill: candidate.skill.name,
          source: candidate.source,
        });
      },
    });
  }

  /**
   * （GEE Kernel v1）执行还原计划：技能表恢复为快照态——快照内的技能逐个 replace，
   * 当前表中快照之外的新增者 remove（`SkillRestorePlan` 的 apply 语义，见端口契约）。
   * @param registry 受种技能注册表（组合根持有具体实现）
   * @param plan 台账产出的还原计划
   * @returns 无返回值（void）
   */
  private static applySkillRestore(registry: SkillRegistry, plan: SkillRestorePlan): void {
    const currentNames = registry.list().map((s) => s.name);
    const targetNames = new Set(plan.skills.map((s) => s.name));
    for (const skill of plan.skills) {
      registry.replace(skill);
    }
    for (const name of currentNames) {
      if (!targetNames.has(name)) {
        registry.remove(name);
      }
    }
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
import type { ResolvedConfig } from '../ports/config/resolvedConfig.js';
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
