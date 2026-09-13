import type { SessionEvent } from '../ports/event.js';
import type { ToolContext } from '../ports/tool.js';
import type { MemoryFact } from '../ports/longTermMemory.js';
import type { ImageContent, FileAttachment } from '../ports/model.js';
import type { OmniHarnessRuntime } from './runtime.js';
import type { EvolutionController, PromotionVerdict } from '../ports/evolution.js';
import type { SparkController, SparkCycleReport } from '../spark/sparkController.js';
import { AppendOnlyEventLog } from './appendOnlyEventLog.js';
import { SessionRecorder } from './sessionRecorder.js';
import { StepRunner } from './stepRunner.js';
import { TurnRunner } from './turnRunner.js';
import type { TurnOutcome } from './turnRunner.js';
import type { AgentPort, AgentResult } from '../ports/agent.js';
import { ContextCompactor } from '../context/contextCompactor.js';
import { ContextWindowCatalog } from '../context/contextWindowCatalog.js';
import { SkillRegistry } from '../skill/skillRegistry.js';
import { LoopGuard } from './loop/loopGuard.js';
import { EventPersister } from './loop/eventPersister.js';
import { CancellationToken } from './loop/cancellationToken.js';
import { id } from '../util/id.js';
import { log, nextTraceId } from '../util/logger.js';

/** 默认压缩参数。 */
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_KEEP_RECENT = 6;

// AgentResult 契约已上移至 ports/agent.ts（端口契约），此处 re-export 以保公开 API 稳定。
export type { AgentResult };

/** Agent 总编排：建会话 → 记录输入 → 跑回合 → 持久化。 */
export class Agent implements AgentPort {
  /** 当前在跑会话的取消令牌（V2）：cancel() 可中断模型请求（signal 贯穿 fetch）。 */
  private currentCancel: CancellationToken | undefined;
  /** 当前在跑会话的增量持久化器（V2）：供 buildTurnRunner 注入 TurnRunner。 */
  private currentPersister: EventPersister | undefined;

  public constructor(
    /** 运行时组合根：提供模型、工具、审批、沙箱、存储、事件总线等全部依赖。 */
    private readonly runtime: OmniHarnessRuntime,
    /** 可选技能注册表：会话启动时按 prompt 匹配命中技能，渲染为 system 事件注入。 */
    private readonly skills?: SkillRegistry,
  ) {}

  /**
   * 取消当前在跑的任务（V2）：模型在飞请求被中断（CancelledError 上抛），
   * 已产生事件仍经 finally 落盘。无在跑任务时为 no-op。
   * @param reason 取消原因，透传给取消令牌并随事件落盘（默认 'user'）。
   */
  public cancelCurrentRun(
    reason: 'user' | 'timeout' | 'shutdown' | { readonly custom: string } = 'user',
  ): void {
    this.currentCancel?.cancel(reason);
  }

  /**
   * 执行一次任务（新会话）。images/files 可选，随首条用户消息送入模型（#B1/#B5）。
   * @param prompt 用户任务文本，作为首条 user 事件进入事件流。
   * @param images 可选图片内容数组，随首条用户消息一并送入模型。
   * @param files 可选文件附件数组，随首条用户消息一并送入模型。
   * @returns 会话执行结果：sessionId、最终文本、步数与全部事件。
   */
  public async runTask(
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    return this.continueSession(undefined, prompt, id('sess'), images, files);
  }

  /**
   * 续跑历史会话：加载原会话历史事件后继续（同一 sessionId）。
   * @param sessionId 要续跑的既有会话 ID，历史事件由此加载。
   * @param prompt 本轮新增的用户指令；空串触发崩溃恢复语义（注入续跑引导）。
   * @param images 可选图片内容数组，随本轮用户消息送入模型。
   * @param files 可选文件附件数组，随本轮用户消息送入模型。
   * @returns 续跑后的会话结果：sessionId、最终文本、步数与含历史的全部事件。
   */
  public async resume(
    sessionId: string,
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    return this.continueSession(sessionId, prompt, sessionId, images, files);
  }

  /**
   * 分叉会话：复制历史事件到新 sessionId，独立演进不影响原会话。
   * @param sourceSessionId 被分叉的源会话 ID，其历史事件被 hydrate 进新会话。
   * @param prompt 分叉后本轮的用户指令。
   * @param images 可选图片内容数组，随本轮用户消息送入模型。
   * @param files 可选文件附件数组，随本轮用户消息送入模型。
   * @returns 新会话的执行结果：新 sessionId、最终文本、步数与全部事件。
   */
  public async fork(
    sourceSessionId: string,
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    return this.continueSession(sourceSessionId, prompt, id('sess'), images, files);
  }

  /**
   * 回放会话：加载并广播全部历史事件。
   * @param sessionId 要回放的会话 ID。
   * @returns 按原始顺序排列的全部历史事件（同时已逐条经事件总线广播）。
   */
  public async replay(sessionId: string): Promise<readonly SessionEvent[]> {
    const events = await this.runtime.storage.load(sessionId);
    for (const event of events) {
      this.runtime.events.emit(event);
    }
    return events;
  }

  /**
   * 会话续跑通用流程：注入历史 → 记录输入 → 跑回合 → 持久化。
   *
   * run/resume/fork 三种模式的汇聚点：run 建全新事件流；resume/fork 先 hydrate
   * 源会话历史，再绑定取消令牌与 write-behind 持久化器跑 TurnRunner，finally
   * 兜底落盘，最后按需跑进化闭环与燧内核收尾。
   *
   * @param sourceId 历史来源会话 ID；undefined 表示全新会话（run 模式）。
   * @param prompt 本轮用户指令；resume 模式下空串触发崩溃恢复引导。
   * @param sessionId 本会话的事件流 ID（resume 与 sourceId 相同，fork 为新 ID）。
   * @param images 可选图片内容数组，随首条用户消息送入模型。
   * @param files 可选文件附件数组，随首条用户消息送入模型。
   * @returns 会话执行结果：sessionId、最终文本、步数与全部事件。
   */
  private async continueSession(
    sourceId: string | undefined,
    prompt: string,
    sessionId: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    const mode: 'run' | 'resume' | 'fork' =
      sourceId === undefined ? 'run' : sessionId === sourceId ? 'resume' : 'fork';
    // 单次会话绑定一个 traceId，期间所有结构化日志自动携带（AsyncLocalStorage 传播）。
    return log.withTrace(nextTraceId(sessionId), async () => {
      log.info('session.start', { sessionId, mode, sourceId });
      const eventLog = new AppendOnlyEventLog();
      if (sourceId !== undefined) {
        eventLog.hydrate(await this.runtime.storage.load(sourceId));
      }
      const recorder = new SessionRecorder(
        eventLog,
        this.runtime.events,
        sessionId,
        this.runtime.retrieval,
      );
      this.injectSkills(recorder, prompt);
      // 长期记忆 primer（#4.2 读取策略）：默认关闭——会把跨会话 fact 拼成"【长期记忆 · 开工前对齐】..."
      // 注入开场 system，模型会在首条回复照原文复述，对终端用户造成"被系统重复念"的视觉噪声。
      // 真需要复用跨会话 fact 时，显式启用：`export OMNI_MEMORY_PRIMER=1` 后再起服务。
      if (process.env.OMNI_MEMORY_PRIMER === '1') {
        this.injectMemoryPrimer(recorder, prompt, sessionId);
      }
      // 新会话打工作区标记（session_meta）：供 UI 按项目收纳会话；resume/fork 已随历史带标记。
      if (mode === 'run') {
        recorder.sessionMeta(this.runtime.config.workspaceRoot);
      }
      // V2.1（B7）：resume 不带提示 = 崩溃/中断恢复语义——注入续跑引导而非空白用户消息，
      // 让模型基于已持久化的历史（含 write-behind 落盘的中间事件）接着当前进度做。
      const effectivePrompt: string =
        mode === 'resume' && prompt.trim() === ''
          ? '【续跑】上次任务在此中断。基于上方会话历史与当前工作区状态接着完成剩余工作，不要重复已完成的步骤。'
          : prompt;
      recorder.user(effectivePrompt, images);
      // V2：会话级取消令牌（贯穿模型请求 fetch）+ 增量持久化器（write-behind）。
      const cancel = new CancellationToken();
      this.currentCancel = cancel;
      const persister = new EventPersister(this.runtime.storage, sessionId, () => eventLog.all());
      this.currentPersister = persister;
      const runner = this.buildTurnRunner(recorder, cancel);
      let outcome: TurnOutcome;
      let persistedAt = 0;
      try {
        outcome = await runner.run(this.contextOf(sessionId));
      } finally {
        this.currentCancel = undefined;
        this.currentPersister = undefined;
        // V2：回合内 write-behind 定时器已由 TurnRunner 收尾 flush+dispose；
        // 此处兜底：无论回合成功还是抛出（模型 500 / 网络中断 / 工具异常 / 取消），
        // 已产生的事件都必须落盘。旧行为是异常直接冒泡、save 被跳过——用户重进
        // 会话看到一片空白，等于历史凭空消失。save 自身失败只告警：绝不能用
        // 持久化错误掩盖原始异常。
        persister.dispose();
        persistedAt = eventLog.size();
        await this.persist(sessionId, eventLog.all());
      }
      // P1 进化闭环（可选、零破坏）：任务完成后若注入了 evolution 且 autoRun 开启，
      // 在 fail-closed 门禁下跑一轮 发现→评估→晋升。异常不影响主任务（fail-closed）。
      await this.runEvolutionIfEnabled(sessionId);
      // 燧内核（S+，可选、零破坏）：任务完成后若注入了 spark 且 autoRun 开启，
      // 跑一轮 燧-3/燧-4 调谐/冲刷（复用 I-P1-4 的 autoRun 钩子范式）。异常不影响主任务。
      await this.runSparkIfEnabled(sessionId);
      // 仅当收尾阶段（evolution/spark）又产生了新事件时才回写，避免长会话重复全量落盘。
      if (eventLog.size() !== persistedAt) {
        await this.persist(sessionId, eventLog.all());
      }
      log.info('session.end', {
        sessionId,
        steps: outcome.steps,
        hasText: outcome.finalText !== undefined,
      });
      return {
        sessionId,
        finalText: outcome.finalText,
        steps: outcome.steps,
        events: eventLog.all(),
      };
    });
  }

  /**
   * 落盘（fail-soft）：持久化失败只告警，不向上抛。
   * 用于 finally 等场景——绝不能用存储错误掩盖模型/工具的原始异常。
   * @param sessionId 事件落盘的目标会话 ID。
   * @param events 要写入存储的完整事件序列（append-only 全量快照）。
   */
  private async persist(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    try {
      await this.runtime.storage.save(sessionId, events);
    } catch (err) {
      log.warn('session.persist.failed', { sessionId, error: String(err) });
    }
  }

  /**
   * 按需注入命中技能（作为 system 事件进日志 → 投影进模型上下文）。
   * @param recorder 会话记录器，命中的技能文本经其写为 system 事件。
   * @param prompt 用户 prompt，作为技能匹配（keywords/触发规则）的输入。
   */
  private injectSkills(recorder: SessionRecorder, prompt: string): void {
    if (this.skills === undefined) {
      return;
    }
    for (const skill of this.skills.match(prompt)) {
      recorder.system(this.skills.render(skill));
    }
  }

  /**
   * 会话开始注入长期记忆 primer（#4.2 读取策略）：把跨会话沉淀的 durable fact
   * 以 system 事件注入开场上下文，使模型开工前先对齐既有偏好/约定/决策/坑。
   * 用开场 prompt 做相关性召回；无命中时退化为按重要度取 top-N，确保始终有基线对齐。
   * 零侵入核心循环：仅为 recorder 追加一条 system 事件，不改变既有执行流。
   * @param recorder 会话记录器，primer 文本经其写为 system 事件。
   * @param prompt 开场用户 prompt，作为相关性召回的查询文本。
   * @param sessionId 当前会话 ID，用于过滤本会话刚沉淀的事实（避免自指回灌）。
   */
  private injectMemoryPrimer(recorder: SessionRecorder, prompt: string, sessionId: string): void {
    const memory = this.runtime.longTermMemory;
    if (memory === undefined || memory.count === 0) {
      return;
    }
    // 不把本次会话刚沉淀的事实回灌进自身开场（避免自指噪声）。
    const relevant = memory.recall(prompt, 5).filter((fact) => fact.sessionId !== sessionId);
    const primer: readonly MemoryFact[] =
      relevant.length > 0
        ? relevant
        : memory
            .all()
            .filter((fact) => fact.sessionId !== sessionId)
            .slice()
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 5);
    if (primer.length === 0) {
      return;
    }
    const lines = primer
      .map((fact) => `- ${fact.text}${fact.topic ? `（${fact.topic}）` : ''}`)
      .join('\n');
    recorder.system(
      '【长期记忆 · 开工前对齐】以下是此前会话沉淀、可跨会话复用的关键事实，请在开工前优先参考这些既有约定：\n' +
        lines,
    );
  }

  /**
   * 构建回合执行器（V2：注入取消信号 + 失控检测 + 增量持久化）。
   * @param recorder 会话记录器，回合内全部事件经其写入事件流并广播。
   * @param cancel 会话级取消令牌，其 AbortSignal 贯穿模型请求 fetch。
   * @returns 装配好的 TurnRunner，负责驱动 step 循环直到任务完成或熔断。
   */
  private buildTurnRunner(recorder: SessionRecorder, cancel: CancellationToken): TurnRunner {
    const step = new StepRunner({
      model: this.runtime.model,
      tools: this.runtime.tools,
      approvals: this.runtime.approvals,
      sandbox: this.runtime.sandbox,
      gate: this.runtime.gate,
      supervisor: this.runtime.supervisor,
      recorder,
      sessionId: recorder.sessionId(),
      compactor: this.buildCompactor(),
      fragments: this.runtime.config.fragments,
      native: this.runtime.native,
      spiller: this.runtime.spiller,
      discovery: this.runtime.discovery,
      escalation: this.runtime.escalation,
      elevatedSandbox: this.runtime.elevatedSandbox,
      hooks: this.runtime.hooks,
      live: this.runtime.live,
      promptInjectionGuard: this.runtime.config.promptInjectionGuard,
      reasoningEffort: this.runtime.config.reasoning,
      // U2：repo-map 上下文注入。默认开；env OMNI_REPO_MAP=0 关闭（不增 config schema，避免破 fail-closed 校验）。
      workspaceRoot: this.runtime.config.workspaceRoot,
      repoMapEnabled: process.env.OMNI_REPO_MAP !== '0',
      // P2.2 单例收敛：引擎实例由组合根（memoryStackAssembler）构造，经 ResolvedConfig 注入。
      repoMapContext: this.runtime.config.repoMapContext,
      // U3 混合检索：仅当运行时注入了 embedding（env OMNI_SEMANTIC_RECALL=1 构造适配器）才走混合路径。
      embedding: this.runtime.embedding,
      // V2：取消信号贯穿模型请求（cancel() → fetch 中断）。
      signal: cancel.toAbortSignal(),
      // 上下文窗口：容量快照的百分比分母（env OMNI_CONTEXT_WINDOW 优先 → 模型名表 → 缺省）。
      contextWindowTokens: this.resolveContextWindow(),
    });
    return new TurnRunner(
      step,
      recorder,
      this.runtime.config.maxSteps,
      this.runtime.turnDiff,
      this.runtime.longTermMemory,
      this.runtime.memoryExtractor,
      buildLoopGuard(),
      // 增量持久化器：EventPersister 由 continueSession 创建并管理生命周期，
      // TurnRunner 只在每步调 schedule()——但构造签名要实例。这里用轻量桥：
      // TurnRunner 持有 persister 引用做 schedule/flush；dispose 由 Agent finally 兜底。
      this.currentPersister,
      // V2.1 token 预算（B4）：config 优先，env OMNI_TURN_TOKEN_BUDGET 兜底，均缺省关闭。
      this.resolveTokenBudget(),
    );
  }

  /**
   * 回合 token 预算解析（V2.1 / B4）：config.turnTokenBudget 优先，
   * env OMNI_TURN_TOKEN_BUDGET 兜底；均未设置或非法时返回 0（关闭，不设预算闸）。
   * @returns 每回合 token 预算上限（正整数）；0 表示未启用预算闸。
   */
  private resolveTokenBudget(): number {
    const fromConfig = this.runtime.config.turnTokenBudget;
    if (typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0) {
      return Math.floor(fromConfig);
    }
    const fromEnv = Number(process.env.OMNI_TURN_TOKEN_BUDGET);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 0;
  }

  /**
   * 解析上下文窗口 token 数（UI 容量面板的百分比分母）。
   *
   * env `OMNI_CONTEXT_WINDOW` 优先（运维可显式纠正厂商表），否则按模型名查
   * {@link ContextWindowCatalog}。与压缩阈值口径**有意分离**：压缩何时触发是行为契约
   * （改动会影响既有会话的折叠时机与测试基线），而窗口大小只是展示口径，两者不互相绑定。
   * @returns 上下文窗口 token 数（env 覆盖值或按模型名查表的容量）。
   */
  private resolveContextWindow(): number {
    const fromEnv = Number(process.env.OMNI_CONTEXT_WINDOW);
    return new ContextWindowCatalog(Number.isFinite(fromEnv) ? fromEnv : undefined).of(
      this.runtime.model.name,
    );
  }

  /**
   * 构建上下文压缩器（V2：阈值挂钩真实 context window，0.8×window 优先于固定值）。
   * @returns 配置好压缩阈值与（可选）原生 token 估算器的 ContextCompactor。
   */
  private buildCompactor(): ContextCompactor {
    const envWindow = Number(process.env.OMNI_CONTEXT_WINDOW);
    const compactor = new ContextCompactor(this.runtime.model, {
      maxTokens: this.runtime.config.compactionMaxTokens ?? DEFAULT_MAX_TOKENS,
      keepRecent: this.runtime.config.compactionKeepRecent ?? DEFAULT_KEEP_RECENT,
      // V2：真实窗口 token 数（env OMNI_CONTEXT_WINDOW）提供时，阈值 = floor(0.8×window)，
      // 对齐 codex/dsh 的「按窗口百分比触发压缩」策略；未提供时维持固定阈值行为。
      ...(Number.isFinite(envWindow) && envWindow > 0 ? { contextWindowTokens: envWindow } : {}),
    });
    // 原生内核可用时，token 估算下沉到 Rust（单次 FFI 往返，与 JS 结果逐位一致）。
    if (this.runtime.native?.estimateTokens !== undefined) {
      compactor.setNativeEstimator((m) => this.runtime.native!.estimateTokens!(m));
    }
    return compactor;
  }

  /**
   * 构造工具上下文。
   * @param sessionId 当前会话 ID，随工具调用透传（供工具区分会话/落审计）。
   * @returns 含会话 ID 与工作区根目录的 ToolContext。
   */
  private contextOf(sessionId: string): ToolContext {
    return { sessionId, workspaceRoot: this.runtime.config.workspaceRoot };
  }

  /**
   * 任务完成后可选跑一轮进化闭环（autoRun 开启时）。异常被吞，绝不连累主任务。
   * @param sessionId 触发本轮进化的会话 ID，仅用于结构化日志关联。
   */
  private async runEvolutionIfEnabled(sessionId: string): Promise<void> {
    const evo: EvolutionController | undefined = this.runtime.evolution;
    if (evo === undefined || !evo.autoRun) {
      return;
    }
    try {
      const verdicts = await evo.cycle();
      const promoted = verdicts.filter((v: PromotionVerdict) => v.promoted).length;
      log.info('evolution.cycle', {
        sessionId,
        evaluated: verdicts.length,
        promoted,
        budget: evo.budgetUsed(),
      });
    } catch (err) {
      log.warn('evolution.cycle.failed', { sessionId, error: String(err) });
    }
  }

  /**
   * 任务完成后可选跑一轮燧内核调谐/冲刷（autoRun 开启时）。异常被吞，绝不连累主任务。
   * @param sessionId 触发本轮燧周期的会话 ID，仅用于结构化日志关联。
   */
  private async runSparkIfEnabled(sessionId: string): Promise<void> {
    const spark: SparkController | undefined = this.runtime.spark;
    if (spark === undefined || !spark.autoRun) {
      return;
    }
    try {
      const report: SparkCycleReport = await spark.cycle();
      log.info('spark.cycle', {
        sessionId,
        ran: report.ran,
        resonance: report.resonance,
        vortex: report.vortex,
        anneal: report.anneal,
        web: report.web,
        qec: report.qec,
        immune: report.immune,
        belief: report.belief,
        crispr: report.crispr,
        crystallizer: report.crystallizer,
        etching: report.etching,
        elementComposer: report.elementComposer,
        symmetry: report.symmetry,
        confinement: report.confinement,
      });
    } catch (err) {
      log.warn('spark.cycle.failed', { sessionId, error: String(err) });
    }
  }
}

/**
 * V2 失控检测器装配（默认开，零 config schema 变更——沿用 env 开关先例）：
 *  - `OMNI_LOOPGUARD=0` 关闭；
 *  - `OMNI_LOOP_MAX_MS=<毫秒>` 设置会话 wall-clock 上限（超时熔断，默认不设）。
 * 检测策略：同调用重复 ≥3 次 / 循环窗口 8 内周期 ≤4 的 A→B→A→B 模式。
 * 首次触发注入纠偏 user 消息，同一违规连续 2 次才熔断（不误杀长任务）。
 * @returns 按环境变量装配好的 LoopGuard（关闭时为零阈值实例，等效禁用检测）。
 */
function buildLoopGuard(): LoopGuard {
  if (process.env.OMNI_LOOPGUARD === '0') {
    return new LoopGuard({ maxExactRepeats: 0, cycleWindow: 0 });
  }
  const maxMs = Number(process.env.OMNI_LOOP_MAX_MS);
  return new LoopGuard({
    maxDurationMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0,
  });
}
