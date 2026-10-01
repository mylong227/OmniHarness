import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { OmniHarnessConfig } from '../ports/config/omniHarnessConfig.js';
import type { ToolInputSink } from '../ports/tool/toolInputSink.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import { CostBudget, DEFAULT_SOFT_RATIO } from '../adapters/model/costBudget.js';
import { CostBudgetDegradeAdapter } from '../adapters/model/costBudgetDegradeAdapter.js';
import { EnforcementModeResolver } from '../security/enforcementModeResolver.js';
import { RoutePricing, DEFAULT_FALLBACK_PRICE } from '../adapters/model/routePricing.js';
import type { BudgetDegradeSignal } from '../ports/model/budgetDegrade.js';
import { log } from '../util/logger.js';
import { ConsoleLiveView } from '../adapters/live/consoleLiveView.js';
import { CompositeLiveView } from '../adapters/live/compositeLiveView.js';
import { TransformersEmbeddingAdapter } from '../adapters/embedding/transformersEmbeddingAdapter.js';

import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { EmbeddingPort } from '../ports/model/embedding.js';
import type { RetrievalPort } from '../ports/intelligence/retrieval.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';
import type { SpillPort } from '../ports/memory/spill.js';
import type { ToolPort } from '../ports/tool/tool.js';
import type { TurnDiffTracker } from '../core/turnDiffTracker.js';
import type { ToolHookRunner } from '../core/toolHookRunner.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import type { MemoryExtractorPort } from '../ports/memory/memoryExtractor.js';
import type { CosmicWebPort } from '../ports/memory/cosmicWeb.js';
import type { MemoryAnnealer } from '../ports/memory/memoryAnnealing.js';
import type { QECEncoder } from '../adapters/memory/qecEncoder.js';
import type { ImmuneMonitor } from '../adapters/monitoring/immuneMonitor.js';
import type { NaturalGradientBelief } from '../adapters/belief/naturalGradientBelief.js';
import type { ParticleFilterBelief } from '../adapters/belief/particleFilterBelief.js';
import type { CRISPRSkillEditor } from '../adapters/skill/crisprSkillEditor.js';
import type { CapabilityCrystallizer } from '../adapters/skill/capabilityCrystallizer.js';
import type { InsightEtchingEngine } from '../adapters/memory/insightEtchingEngine.js';
import type { ElementComposer } from '../adapters/skill/elementComposer.js';
import type { SymmetryBreakingEngine } from '../adapters/monitoring/symmetryBreakingEngine.js';
import type { ConfinementEngine } from '../adapters/monitoring/confinementEngine.js';
import type { SkillRegistry } from '../skill/skillRegistry.js';
import type { SparkController } from '../spark/sparkController.js';
import type { ToolDiscovery } from '../search/toolDiscovery.js';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../autonomy/goalRunner.js';

import type { LspPort } from '../ports/tool/lsp.js';
import type { AgentIdentityPort } from '../ports/runtime/agentIdentity.js';
import type { SubagentPortsShape } from '../subagent/subagentPorts.js';
import type { SubagentOptions } from '../subagent/subagentTypes.js';
import type { UserResponder } from '../ports/runtime/userResponder.js';
import type { TodoPort } from '../ports/runtime/todo.js';
import type { PlanPort } from '../ports/runtime/plan.js';
import type { EvolutionController } from '../ports/runtime/evolution.js';

import { ConfigBuilder } from './configBuilder.js';
import { ConfigToolRegistry } from './configToolRegistry.js';
import type { MediaStack } from './mediaStackAssembler.js';
import { SelfVerifyPolicy } from '../adapters/tool/verify/selfVerifyPolicy.js';
import { DecisionEngineResolver } from './decisionEngineResolver.js';
import { FileDecisionTraceAdapter } from '../adapters/decision/fileDecisionTraceAdapter.js';
import { CorePortsAssembler } from './corePortsAssembler.js';
import type { CorePorts } from './corePortsAssembler.js';
import { MemoryStackAssembler } from './memoryStackAssembler.js';
import { RepoMapContextEngine } from '../context/repoMapContextEngine.js';
import type { ScratchpadPort } from '../ports/memory/scratchpad.js';
import { SkillStackAssembler } from './skillStackAssembler.js';
import { SparkAssembler } from './sparkAssembler.js';

export type { OmniHarnessConfig } from '../ports/config/omniHarnessConfig.js';
export type { SelfVerifyConfig } from '../ports/config/selfVerifyConfig.js';
export type { DecisionEngineConfig } from '../ports/config/decisionEngineConfig.js';
export interface ResolvedConfig extends OmniHarnessConfig {
  readonly approvals: ApprovalPort;
  readonly sandbox: SandboxPort;
  readonly events: EventPort;
  readonly tools: ToolPort;
  readonly spill: SpillPort;
  readonly spiller: ToolResultSpiller;
  readonly planMode: boolean;
  readonly userResponder: UserResponder;
  readonly todo: TodoPort;
  readonly plan: PlanPort;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，使延迟加载工具后续回合对模型可见。 */
  readonly discovery: ToolDiscovery;
  /** 检索端口（#M2）：会话历史事件索引供 memory_search 检索，实现跨长对话 recall。 */
  readonly retrieval: RetrievalPort;
  /** 升级审批端口（#G3/G4）：沙箱拒绝时咨询，决定是否提权重试（fail-closed 默认不提权）。 */
  readonly escalation: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，默认 policy=fail-closed 收紧）：escalate 裁决后以此复核放行，危险命令/工作区外路径仍拦。 */
  readonly elevatedSandbox: SandboxPort;
  /** 回合级变更追踪器（#M5）：关闭时为 undefined，不追踪也不产事件。与 `OmniHarnessConfig.turnDiff`（布尔开关）区分命名，避免类型冲突。 */
  readonly turnDiffTracker?: TurnDiffTracker | undefined;
  /** 工具钩子运行器（#M5）：变更追踪钩子注册于此；无追踪需求时为 undefined。 */
  readonly hooks?: ToolHookRunner | undefined;
  /** 长期记忆端口（#S28）：跨会话持久 fact 存储，默认文件落盘；recall 工具与回合末蒸馏共用。 */
  readonly longTermMemory: LongTermMemoryPort;
  /** repo-map 上下文引擎（P2.2 单例收敛）：组合根唯一构造点，注入 StepRunnerDeps。 */
  readonly repoMapContext: RepoMapContextEngine;
  /** 跨重置便签（T3.4）：重置后读回交接物恢复任务。 */
  readonly scratchpad: ScratchpadPort;
  /** 长期记忆蒸馏器（#S28，可选）：模型存在且未关 memoryConsolidate 时构造，回合末自动沉淀；否则 undefined（仅支持显式 remember）。 */
  readonly memoryExtractor?: MemoryExtractorPort | undefined;
  /** 成本预算计量（#S29，可选）：配置 costBudgetUsd 正数时构造，BudgetedModel 与 budget_status 工具共享同一实例（含子代）。 */
  readonly costBudget?: CostBudget | undefined;
  /**
   * 预算降级信号端口（P5 自动降档，可选）：仅当 `costBudget` 存在时桥接构造，供 `core`
   * 消费点（`StepContextBuilder`）在软阈值越过后收敛检索预算。缺省（无预算）为 undefined
   * ⇒ 消费点 `?.shouldDegrade` 恒 false，零行为变更。建模为端口是为守住 `core → adapters` 架构红线。
   */
  readonly budgetDegrade?: BudgetDegradeSignal | undefined;
  /** 自主目标循环最大迭代次数（#S30，默认 10，CLI/工具可覆盖）。 */
  readonly goalMaxIterations: number;
  /** LSP 代码导航端口（#S32，可选）：配置了 lsp 服务器时构造 LspProcessAdapter，否则 undefined（LSP 工具不注册）。 */
  readonly lsp?: LspPort | undefined;
  /** Agent 密码学身份端口（#S33，可选）：配置了 agentIdentity 时构造 Ed25519AgentIdentity，否则 undefined（agent_identity 工具不注册）。 */
  readonly identity?: AgentIdentityPort | undefined;
  /** 工具输入实时观察端口（#B3，可选）：模型流式生成的工具参数增量经此推给 UI；由 ConfigFactory 默认 ConsoleLiveView。 */
  readonly live?: ToolInputSink | undefined;
  /** 语义嵌入端口（U3 混合检索，可选）：env OMNI_SEMANTIC_RECALL=1 时由 ConfigFactory 构造并注入本地 ONNX 嵌入适配器；默认 undefined（纯 BM25、零开销）。 */
  readonly embedding?: EmbeddingPort | undefined;
  /** 进化闭环控制器（P1，可选）：注入后 Agent 任务完成后可在 fail-closed 门禁下跑发现→评估→晋升；缺省不启用，零破坏。 */
  readonly evolution?: EvolutionController | undefined;
  /** 燧内核控制器（S+，可选）：任一燧能力启用时构造，Agent 任务完成后可在 fail-closed 下跑 燧-3/燧-4 调谐/冲刷/(D) 退火/(E) 宇宙网/QEC/免疫；缺省不启用，零破坏。 */
  readonly spark?: SparkController | undefined;
  /** (D) 热方程记忆退火器（memoryAnnealing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly annealer?: MemoryAnnealer | undefined;
  /** (E, I-P1-2) 宇宙网记忆端口（U1 默认开时即 ResonantField 单一状态源，实现 CosmicWebPort，注入 spark）；缺省 undefined，零破坏。 */
  readonly web?: CosmicWebPort | undefined;
  /** (E, I-P1-3) QEC 记忆编码器（qec.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly qecEncoder?: QECEncoder | undefined;
  /** (E, I-P1-5) 免疫异常监控器（immuneMonitoring.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly immune?: ImmuneMonitor | undefined;
  /** (P2, I-P2-2) 自然梯度信念引擎（belief 启用且 algorithm 含 natural-gradient 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly naturalGradient?: NaturalGradientBelief | undefined;
  /** (P2, I-P2-3) 粒子滤波信念引擎（belief 启用且 algorithm 含 particle-filter 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly particleFilter?: ParticleFilterBelief | undefined;
  /** (P2, I-P2-4/5) 受种技能注册表：CRISPR 编辑面 / 相变固化组合解析面；同时可注入 Agent 增强技能匹配。 */
  readonly skillRegistry: SkillRegistry;
  /** (P2, I-P2-4) CRISPR 精确技能编辑器（skillEditing.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crispr?: CRISPRSkillEditor | undefined;
  /** (P2, I-P2-5) 相变固化器（capabilityCrystallization.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly crystallizer?: CapabilityCrystallizer | undefined;
  /** (P3, I-P3-1) 刻蚀记忆引擎（insightEtching.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly etching?: InsightEtchingEngine | undefined;
  /** (P3, I-P3-2) 元素组合基元引擎（elementComposer.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly elementComposerEngine?: ElementComposer | undefined;
  /** (P3, I-P3-3) 对称破缺引擎（symmetryBreaking.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly symmetry?: SymmetryBreakingEngine | undefined;
  /** (P3, I-P3-4) 禁闭色荷引擎（confinement.enabled 时构造并注入 spark）；缺省 undefined，零破坏。 */
  readonly confinementEngine?: ConfinementEngine | undefined;
}

/** 子智能体端口种子（缺 tools，待注册表构造完成后回填）。 */
export type SubagentPortSeed = Omit<SubagentPortsShape, 'tools'> & {
  readonly subagent: SubagentOptions;
  /** 自主目标循环默认最大迭代次数（#S30，供 run_goal 工具读取）。 */
  readonly goalMaxIterations: number;
  /**
   * 已装配的媒体抽帧栈（动画 GIF / 视频的逐帧判读）。
   *
   * 为什么放在种子里而不是让工具自己 new：`view_media` 同一份栈要同时喂给主会话工具集与
   * 子代工具集（`defaultTools` 两个调用路径共用本种子）——各自装配会得到**两个独立的
   * ffmpeg 定位缓存**（多跑一遍 `-version`）与两套可能漂移的预算口径。
   * 种子本就是「装配工具集所需的一切」的收口（`spill` / `events` / `workspaceRoot` 同理）。
   */
  readonly media: MediaStack;
};

/**
 * 配置装配器（组合根）：填默认端口，未注入的用内置实现。
 *
 * 只做**编排**，不亲自装配具体端口——四类领域装配函数各司其职（同目录顶层函数范式，与
 * `configToolRegistry.ts` 一致）：
 * `assembleCorePorts`（基础设施）、`assembleMemoryStack`（长期记忆栈 + 知识算子）、
 * `assembleSkillStack`（技能 / 能力算子栈）、`assembleSpark`（燧内核）。
 * 本类负责确定装配顺序（记忆封包必须先于蒸馏器 / 燧内核，保证单一状态源）、
 * 构造成本预算与模型，并把各切片拼成 `ResolvedConfig`。
 */
export class ConfigFactory {
  /**
   * 构造完整配置。
   * @param partial 未解析的运行配置（用户注入优先，缺省落内置实现）。
   * @returns 全部端口已填默认实现的 `ResolvedConfig`。
   */
  public static build(partial: OmniHarnessConfig): ResolvedConfig {
    const core = CorePortsAssembler.assembleCorePorts(partial);
    const costBudget = ConfigFactory.buildCostBudget(partial);
    // P5 自动降档：把预算计量桥成只读端口，注入 core 消费点（守住 `core → adapters` 红线）。
    // 无预算（costBudgetUsd 未设/非正）时不构造 ⇒ budgetDegrade 恒 undefined，零行为变更。
    const budgetDegrade: BudgetDegradeSignal | undefined =
      costBudget !== undefined ? new CostBudgetDegradeAdapter(costBudget) : undefined;
    const model = ConfigBuilder.buildModel(partial, costBudget);
    const memory = MemoryStackAssembler.assembleMemoryStack(partial, model);
    const skills = SkillStackAssembler.assembleSkillStack(partial);
    const goalMaxIterations = partial.goalMaxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS;
    // #S32 LSP 代码导航：配置了服务器命令才构造进程级适配器；否则 undefined（LSP 工具不注册，主循环零侵入）。
    const lsp = ConfigBuilder.buildLsp(partial);
    // #S33 Agent 密码学身份：配置了私钥/runtimeId 才构造 Ed25519 身份；否则 undefined（agent_identity 工具不注册）。
    const identity = ConfigBuilder.buildIdentity(partial);
    const seed = ConfigBuilder.seedOf(
      partial,
      core.ports.approvals,
      core.ports.sandbox,
      core.ports.events,
      core.ports.spill,
      core.ports.spiller,
      core.ports.escalation,
      core.ports.elevatedSandbox,
      memory.stack.longTermMemory,
      costBudget,
    );
    const spark = SparkAssembler.assembleSpark(partial, { vortex: core.vortex, memory, skills });
    return {
      workspaceRoot: partial.workspaceRoot,
      maxSteps: partial.maxSteps,
      turnTokenBudget: partial.turnTokenBudget,
      reasoning: partial.reasoning,
      model,
      storage: partial.storage,
      compactionMaxTokens: partial.compactionMaxTokens,
      compactionKeepRecent: partial.compactionKeepRecent,
      compactionDeterministicShrink: partial.compactionDeterministicShrink,
      fragments: partial.fragments,
      native: partial.native,
      live: partial.live ?? new CompositeLiveView([new ConsoleLiveView()]),
      // 语义嵌入端口：`OMNI_SEMANTIC_RECALL=1` 才构造（见 buildEmbeddingPort；L5 预热默认关）。
      embedding: ConfigFactory.buildEmbeddingPort(),
      evolution: partial.evolution,
      // (U4) RLVR 进化闭环：此前该字段只在 `OmniHarnessConfig` 上声明、**未被本装配字面量透传**，
      // 导致调用方即便设置 `evolutionRlvr` 也会在此处被静默丢弃，`createRuntime` 恒读不到
      // → 「默认关、端到端未开」的机械根因。此处显式透传；`createRuntime` 在 `enabled===true`
      // 时构造「可验证门禁 + RLVR sample-filter-replay」控制器。
      evolutionRlvr: partial.evolutionRlvr,
      ssrfPolicy: partial.ssrfPolicy, // 配置化 SSRF 策略表（消费方：组合根 A2A / CLI 出站守卫）
      // 媒体抽帧配置：**原样透传**（不做二次收敛）。为什么留原始形态而不换成已解析选项：
      //  `ResolvedConfig extends OmniHarnessConfig` ⇒ 消费方（服务端配置页 / 切换工作区重基
      //  `ConfigRebase`）读到的 `config.media` 必须还是**声明式字段**，否则「重基」会把一份
      //  烘死了旧环境的解析结果搬到新工作区；已解析的产物（提取路由 + 收敛值）随种子进入工具集，
      //  不在此重复暴露。若此处漏透传，`config.media` 恒为 `undefined` 而 TS 不报错
      //  （字段可选）—— 正是本仓高频的「声明未接线」形态（同 `a2a` / `evolutionRlvr`）。
      media: partial.media,
      // (P4) 提示注入护栏开关：此前该字段只在 `OmniHarnessConfig` 上**声明**（第 220 行）却**未被本
      // 装配字面量透传**；而 `ResolvedConfig extends OmniHarnessConfig` 且该字段可选 ⇒ TS 不报错、
      // 值被静默丢弃，`agent` 读到的 `config.promptInjectionGuard` 恒为 `undefined`
      // ⇒ `--guard-prompt-injection` 形同虚设、护栏在生产路径上**永不可达**（第九处「声明未接线」，
      // 与 E2 的 a2a / E3 的 evolutionRlvr 同一形态）。此处显式透传；缺省 `undefined` = 默认关（零行为变更）。
      // (D1/D2) 生效模式三态：布尔**原样透传**（`true`=enforce / `false`=off——既有断言与零行为变更均保留）；
      // **字符串必须过白名单校验**：未知取值在此抛错，而不是静默回落成 off——否则「配置写错」会静默
      // 退化成「护栏失效」，与 `src/cli/cliEnums.ts`「安全相关枚举必须显式校验」同一纪律。
      promptInjectionGuard:
        typeof partial.promptInjectionGuard === 'string'
          ? EnforcementModeResolver.modeOf(partial.promptInjectionGuard)
          : partial.promptInjectionGuard,
      runtimeTelemetry: partial.runtimeTelemetry,
      costBudget,
      budgetDegrade,
      goalMaxIterations,
      lsp,
      identity,
      spark,
      // (U6) A2A 互操作：此前该字段只在 `OmniHarnessConfig` 上声明、**未被本装配字面量透传**，
      // 导致 `runtime` 的 `if (config.a2a?.enabled === true)` 恒不可达 —— A2A 生产路径整体不可用
      // （U6 回环实测脚本直接 import a2a 模块、绕过了装配层，故长期未暴露）。此处显式透传。
      a2a: partial.a2a,
      tools: ConfigFactory.resolveTools(
        partial,
        seed,
        core.ports,
        memory.stack.longTermMemory,
        costBudget,
        lsp,
        identity,
      ),
      ...core.ports,
      ...memory.stack,
      ...skills,
    };
  }

  /**
   * 装配工具端口（`tools` 字段的**唯一构造点**）。
   *
   * 为什么从 `build` 里抽出来：`build` 的职责是「编排」（定装配顺序、拼各切片），而工具端口的
   * 装配是一次**参数转发 + 条件装饰**——`defaultTools` 十余个入参，末尾还有一层由
   * `selfVerify` 决定的「写后跑受限测试并回灌」装饰。留在字面量中间会把 `build` 的体量推向
   * 门禁上限（`scripts/check.mjs` 的函数体红线），也让「工具集从哪来」这件事淹没在配置字段里。
   *
   * @param partial 未解析的运行配置（读 `tools` / `extraTools` / `workers` / `deferredTools` / `selfVerify`）。
   * @param seed 子代端口种子（工具装配所需的一切端口，含媒体抽帧栈）。
   * @param ports 基础设施端口切片（计划 / 发现 / 检索等）。
   * @param longTermMemory 长期记忆端口（`remember` / `recall` 仅在其存在时注册）。
   * @param costBudget 成本预算（`budget_status` 仅在其存在时注册）。
   * @param lsp LSP 端口（导航 / 诊断工具仅在其存在时注册）。
   * @param identity 密码学身份端口（`agent_identity` 仅在其存在时注册）。
   * @returns 工具端口；调用方显式传入 `tools` 时原样返回，否则走内置注册表（可能已叠加装饰器）。
   */
  private static resolveTools(
    partial: OmniHarnessConfig,
    seed: SubagentPortSeed,
    ports: CorePorts,
    longTermMemory: LongTermMemoryPort,
    costBudget: CostBudget | undefined,
    lsp: LspPort | undefined,
    identity: AgentIdentityPort | undefined,
  ): ToolPort {
    if (partial.tools !== undefined) {
      return partial.tools;
    }
    // 决策引擎：off/缺省零行为；shadow 仅观测、enforce 回灌 noul 预判（质量信号，全程 fail-open）。
    const decisionEngine = new DecisionEngineResolver().resolve(partial);
    const decisionMode = partial.decisionEngine?.mode;
    const verdictMode =
      decisionEngine !== undefined && (decisionMode === 'enforce' || decisionMode === 'shadow')
        ? decisionMode
        : undefined;
    // trace 埋点（§34.7 ①）：引擎生效且未显式关 trace 时落盘配对样本供离线 RLCD 校准（fail-open 由适配器内部吞掉写入异常）。
    const verdictTrace =
      verdictMode !== undefined && (partial.decisionEngine?.trace ?? true)
        ? new FileDecisionTraceAdapter(partial.workspaceRoot)
        : undefined;
    return ConfigToolRegistry.defaultTools(
      seed,
      partial.extraTools,
      partial.workers,
      {
        todo: ports.todo,
        plan: ports.plan,
        userResponder: ports.userResponder,
        planMode: ports.planMode,
      },
      ports.discovery,
      ports.retrieval,
      partial.deferredTools,
      longTermMemory,
      costBudget,
      lsp,
      identity,
      ConfigFactory.resolveSelfVerify(partial),
      decisionEngine,
      verdictMode,
      verdictTrace,
    );
  }

  /**
   * 解析自验证回环策略（P3）。
   *
   * 仅当 `config.selfVerify.enabled === true` 时进一步解析命令：
   * **显式 `selfVerify.command` 直接生效**（不再被「有测试症状」闸门挡住——原实现把显式命令
   * 也一并拦下，属声明未接线）；缺省时由 `SelfVerifyCommandDetector` 从仓库证据推断
   * （npm / pytest / cargo / go / maven / gradle / rspec / dotnet / make）。两者皆无则
   * 返回 `undefined`（不包装装饰器，零行为变更）。
   *
   * @param partial 未解析的运行配置。
   * @returns 自验证策略；未启用、或既无显式命令又探测不到测试症状时为 `undefined`。
   */
  private static resolveSelfVerify(partial: OmniHarnessConfig): SelfVerifyPolicy | undefined {
    const cfg = partial.selfVerify;
    if (cfg === undefined || cfg.enabled !== true || typeof partial.workspaceRoot !== 'string') {
      return undefined;
    }
    return SelfVerifyPolicy.forWorkspace(partial.workspaceRoot, {
      ...(cfg.command !== undefined ? { command: cfg.command } : {}),
      ...(cfg.cooldownMs !== undefined ? { cooldownMs: cfg.cooldownMs } : {}),
      ...(cfg.maxRunsPerSession !== undefined ? { maxRunsPerSession: cfg.maxRunsPerSession } : {}),
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(cfg.maxOutputBytes !== undefined ? { maxOutputBytes: cfg.maxOutputBytes } : {}),
      ...(cfg.maxDigestLines !== undefined ? { maxDigestLines: cfg.maxDigestLines } : {}),
    });
  }

  /**
   * buildCostBudget — module-level helper moved into ConfigFactory.
   * @param {OmniHarnessConfig} partial - partial
   * @returns {CostBudget | undefined} - result
   */
  private static buildCostBudget(partial: OmniHarnessConfig): CostBudget | undefined {
    if (partial.costBudgetUsd === undefined || partial.costBudgetUsd <= 0) {
      return undefined;
    }
    // P5：此前第 4 参（onExceed）恒传 `undefined` ⇒ 越硬预算时只置标记、**无任何上报**，
    // 是个「接线预留但从未接通」的死旋钮。此处接通：硬熔断记 error、软阈值记 warn，
    // 均可被日志管道 / 事件桥观测；降级决策另经 `BudgetSnapshot.degradeSuggested` 暴露。
    return new CostBudget(
      partial.costBudgetUsd,
      RoutePricing.mergeRoutePricing(partial.routePricing),
      DEFAULT_FALLBACK_PRICE,
      (snapshot) => {
        log.error('budget.exceeded', {
          limitUsd: snapshot.limitUsd,
          spentUsd: Number(snapshot.spentUsd.toFixed(6)),
        });
      },
      partial.costBudgetOnExceed !== 'warn',
      partial.costBudgetSoftRatio ?? DEFAULT_SOFT_RATIO,
      (snapshot) => {
        log.warn('budget.softExceeded', {
          limitUsd: snapshot.limitUsd,
          softLimitUsd: Number(snapshot.softLimitUsd.toFixed(6)),
          spentUsd: Number(snapshot.spentUsd.toFixed(6)),
        });
      },
    );
  }

  /**
   * 构造语义嵌入端口（U3 混合检索），并按需触发 L5 预热。
   *
   * @returns 嵌入端口；`OMNI_SEMANTIC_RECALL !== '1'` 时为 `undefined`（纯 BM25、零开销）。
   */
  public static buildEmbeddingPort(): EmbeddingPort | undefined {
    if (process.env.OMNI_SEMANTIC_RECALL !== '1') {
      return undefined;
    }
    const adapter = new TransformersEmbeddingAdapter({
      cacheDir: process.env.OMNI_EMBEDDING_CACHE_DIR,
      localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
      // 模型下载源：`OMNI_HF_ENDPOINT` 优先、回落 `HF_ENDPOINT`（见 resolveRemoteHostFromEnv）。
      // 此前**只有评测脚本**（evals/recall-*-real.mjs）自行设 `env.remoteHost`，生产装配路径
      // 没有任何旋钮 ⇒ 无法直连 huggingface.co 的网络上语义检索**必然不可达**——典型的
      // 「基准脚本绕过装配层给假绿灯」（缺陷形态④）。此处补齐生产入口，使该能力可真正部署。
      // 未配置时为 undefined ⇒ 沿用该库默认源，零行为变更。
      remoteHost: TransformersEmbeddingAdapter.resolveRemoteHostFromEnv(),
    });
    if (TransformersEmbeddingAdapter.shouldPreloadEmbedding()) {
      // L5 预热：把冷启动成本从「首个用户查询」提前到「启动后、接流量前」。
      // **刻意不 await**：装配是同步路径，预热不得阻塞启动；失败由 preload() 自身兜成
      // `{ok:false}` 并落观测（契约保证不抛错），可用性判断仍由首次真实 embed 的 fail-closed 决定。
      void adapter.preload();
    }
    return adapter;
  }
}

export type { ExtraTool } from '../ports/tool/extraTool.js';

// 成本预算（#S29）：设正数硬预算时构造单例，`BudgetedModel` 与 `budget_status` 工具共享
// （含子代同一实例）。非正数 / 未设置即关闭。
//
// 注（2026-09-21）：本段原为 JSDoc 却**没有任何声明跟随其后**（悬空注释）。悬空 JSDoc 会被
// **下一个**声明吸收——文档工具/编辑器会把这段说明挂到别的头上，是实打实的误挂隐患。
// 故降级为普通注释，内容一字未删。
