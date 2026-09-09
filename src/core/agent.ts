import type { SessionEvent } from '../ports/event.js';
import type { ToolContext } from '../ports/tool.js';
import type { MemoryFact } from '../ports/longTermMemory.js';
import type { ImageContent, FileAttachment } from '../ports/model.js';
import type { OmniHarnessRuntime } from './runtime.js';
import type { EvolutionController, PromotionVerdict } from '../ports/evolution.js';
import type { SparkController, SparkCycleReport } from '../spark/sparkController.js';
import { AppendOnlyEventLog } from './eventLog.js';
import { SessionRecorder } from './sessionRecorder.js';
import { StepRunner } from './stepRunner.js';
import { TurnRunner } from './turnRunner.js';
import type { TurnOutcome } from './turnRunner.js';
import { ContextCompactor } from '../context/contextCompactor.js';
import { SkillRegistry } from '../skill/skillRegistry.js';
import { LoopGuard } from './loop/loopGuard.js';
import { EventPersister } from './loop/eventPersister.js';
import { CancellationToken } from './loop/cancellation.js';
import { id } from '../util/id.js';
import { log, Logger } from '../util/logger.js';

/** 默认压缩参数。 */
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_KEEP_RECENT = 6;

/** Agent 运行结果。 */
export interface AgentResult {
  readonly sessionId: string;
  readonly finalText?: string;
  readonly steps: number;
  readonly events: readonly SessionEvent[];
}

/** Agent 总编排：建会话 → 记录输入 → 跑回合 → 持久化。 */
export class Agent {
  /** 当前在跑会话的取消令牌（V2）：cancel() 可中断模型请求（signal 贯穿 fetch）。 */
  private currentCancel: CancellationToken | undefined;
  /** 当前在跑会话的增量持久化器（V2）：供 buildTurnRunner 注入 TurnRunner。 */
  private currentPersister: EventPersister | undefined;

  constructor(
    private readonly runtime: OmniHarnessRuntime,
    private readonly skills?: SkillRegistry,
  ) {}

  /**
   * 取消当前在跑的任务（V2）：模型在飞请求被中断（CancelledError 上抛），
   * 已产生事件仍经 finally 落盘。无在跑任务时为 no-op。
   */
  cancelCurrentRun(reason: 'user' | 'timeout' | 'shutdown' | { readonly custom: string } = 'user'): void {
    this.currentCancel?.cancel(reason);
  }

  /** 执行一次任务（新会话）。images/files 可选，随首条用户消息送入模型（#B1/#B5）。 */
  async runTask(
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    return this.continueSession(undefined, prompt, id('sess'), images, files);
  }

  /** 续跑历史会话：加载原会话历史事件后继续（同一 sessionId）。 */
  async resume(
    sessionId: string,
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    return this.continueSession(sessionId, prompt, sessionId, images, files);
  }

  /** 分叉会话：复制历史事件到新 sessionId，独立演进不影响原会话。 */
  async fork(
    sourceSessionId: string,
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult> {
    return this.continueSession(sourceSessionId, prompt, id('sess'), images, files);
  }

  /** 回放会话：加载并广播全部历史事件。 */
  async replay(sessionId: string): Promise<readonly SessionEvent[]> {
    const events = await this.runtime.storage.load(sessionId);
    for (const event of events) {
      this.runtime.events.emit(event);
    }
    return events;
  }

  /** 会话续跑通用流程：注入历史 → 记录输入 → 跑回合 → 持久化。 */
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
    return log.withTrace(Logger.nextTraceId(sessionId), async () => {
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
      recorder.user(prompt, images);
      // V2：会话级取消令牌（贯穿模型请求 fetch）+ 增量持久化器（write-behind）。
      const cancel = new CancellationToken();
      this.currentCancel = cancel;
      const persister = new EventPersister(
        this.runtime.storage,
        sessionId,
        () => eventLog.all(),
      );
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
   */
  private async persist(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    try {
      await this.runtime.storage.save(sessionId, events);
    } catch (err) {
      log.warn('session.persist.failed', { sessionId, error: String(err) });
    }
  }

  /** 按需注入命中技能（作为 system 事件进日志 → 投影进模型上下文）。 */
  private injectSkills(recorder: SessionRecorder, prompt: string): void {
    if (this.skills === undefined) {
      return;
    }
    for (const skill of this.skills.match(prompt)) {
      recorder.system(SkillRegistry.render(skill));
    }
  }

  /**
   * 会话开始注入长期记忆 primer（#4.2 读取策略）：把跨会话沉淀的 durable fact
   * 以 system 事件注入开场上下文，使模型开工前先对齐既有偏好/约定/决策/坑。
   * 用开场 prompt 做相关性召回；无命中时退化为按重要度取 top-N，确保始终有基线对齐。
   * 零侵入核心循环：仅为 recorder 追加一条 system 事件，不改变既有执行流。
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

  /** 构建回合执行器（V2：注入取消信号 + 失控检测 + 增量持久化）。 */
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
      // U3 混合检索：仅当运行时注入了 embedding（env OMNI_SEMANTIC_RECALL=1 构造适配器）才走混合路径。
      embedding: this.runtime.embedding,
      // V2：取消信号贯穿模型请求（cancel() → fetch 中断）。
      signal: cancel.toAbortSignal(),
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
    );
  }

  /** 构建上下文压缩器（V2：阈值挂钩真实 context window，0.8×window 优先于固定值）。 */
  private buildCompactor(): ContextCompactor {
    const envWindow = Number(process.env.OMNI_CONTEXT_WINDOW);
    const compactor = new ContextCompactor(this.runtime.model, {
      maxTokens: this.runtime.config.compactionMaxTokens ?? DEFAULT_MAX_TOKENS,
      keepRecent: this.runtime.config.compactionKeepRecent ?? DEFAULT_KEEP_RECENT,
      // V2：真实窗口 token 数（env OMNI_CONTEXT_WINDOW）提供时，阈值 = floor(0.8×window)，
      // 对齐 codex/dsh 的「按窗口百分比触发压缩」策略；未提供时维持固定阈值行为。
      ...(Number.isFinite(envWindow) && envWindow > 0
        ? { contextWindowTokens: envWindow }
        : {}),
    });
    // 原生内核可用时，token 估算下沉到 Rust（单次 FFI 往返，与 JS 结果逐位一致）。
    if (this.runtime.native?.estimateTokens !== undefined) {
      compactor.setNativeEstimator((m) => this.runtime.native!.estimateTokens!(m));
    }
    return compactor;
  }

  /** 构造工具上下文。 */
  private contextOf(sessionId: string): ToolContext {
    return { sessionId, workspaceRoot: this.runtime.config.workspaceRoot };
  }

  /** 任务完成后可选跑一轮进化闭环（autoRun 开启时）。异常被吞，绝不连累主任务。 */
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

  /** 任务完成后可选跑一轮燧内核调谐/冲刷（autoRun 开启时）。异常被吞，绝不连累主任务。 */
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
