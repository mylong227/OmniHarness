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
import { ContextCompactor } from '../context/contextCompactor.js';
import { SkillRegistry } from '../skill/skillRegistry.js';
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
  constructor(
    private readonly runtime: OmniHarnessRuntime,
    private readonly skills?: SkillRegistry,
  ) {}

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
      const runner = this.buildTurnRunner(recorder);
      const outcome = await runner.run(this.contextOf(sessionId));
      // P1 进化闭环（可选、零破坏）：任务完成后若注入了 evolution 且 autoRun 开启，
      // 在 fail-closed 门禁下跑一轮 发现→评估→晋升。异常不影响主任务（fail-closed）。
      await this.runEvolutionIfEnabled(sessionId);
      // 燧内核（S+，可选、零破坏）：任务完成后若注入了 spark 且 autoRun 开启，
      // 跑一轮 燧-3/燧-4 调谐/冲刷（复用 I-P1-4 的 autoRun 钩子范式）。异常不影响主任务。
      await this.runSparkIfEnabled(sessionId);
      await this.runtime.storage.save(sessionId, eventLog.all());
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

  /** 构建回合执行器。 */
  private buildTurnRunner(recorder: SessionRecorder): TurnRunner {
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
    });
    return new TurnRunner(
      step,
      recorder,
      this.runtime.config.maxSteps,
      this.runtime.turnDiff,
      this.runtime.longTermMemory,
      this.runtime.memoryExtractor,
    );
  }

  /** 构建上下文压缩器。 */
  private buildCompactor(): ContextCompactor {
    const compactor = new ContextCompactor(this.runtime.model, {
      maxTokens: this.runtime.config.compactionMaxTokens ?? DEFAULT_MAX_TOKENS,
      keepRecent: this.runtime.config.compactionKeepRecent ?? DEFAULT_KEEP_RECENT,
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
