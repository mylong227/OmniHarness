import type { SessionEvent } from '../ports/runtime/event.js';
import type { ToolContext } from '../ports/tool/tool.js';
import type { MemoryFact } from '../ports/memory/longTermMemory.js';
import type { ImageContent, FileAttachment } from '../ports/model/model.js';
import type { OmniHarnessRuntime } from './runtime.js';
import type { EvolutionController, PromotionVerdict } from '../ports/runtime/evolution.js';
import type { SparkController, SparkCycleReport } from '../spark/sparkController.js';
import { AppendOnlyEventLog } from './appendOnlyEventLog.js';
import { SessionRecorder } from './sessionRecorder.js';
import { StepRunner } from './stepRunner.js';
import { TurnRunner } from './turnRunner.js';
import type { TurnOutcome } from './turnRunner.js';
import type { AgentPort, AgentResult } from '../ports/runtime/agent.js';
import { ContextCompactor } from '../context/contextCompactor.js';
import { ContextWindowCatalog } from '../context/contextWindowCatalog.js';
import { SkillRegistry } from '../skill/skillRegistry.js';
import { SkillSparsifier } from '../skill/skillSparsifier.js';
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

// T5.4 技能稀疏化默认参数：预算 5 条，名字命中级（score ≥ 3）豁免预算。
const SKILL_SPARSE_MAX = 5;
const SKILL_SPARSE_MIN_KEEP = 3;

/** 长期记忆 primer 产物的内容特征前缀（与 `injectMemoryPrimer` 拼出的开场文本同源）。 */
const MEMORY_PRIMER_MARKER = '【长期记忆 · 开工前对齐】';

/** Agent 总编排：建会话 → 记录输入 → 跑回合 → 持久化。 */
export class Agent implements AgentPort {
  /**
   * 在跑会话的取消令牌与增量持久化器，**按 sessionId 隔离**。
   *
   * 为什么必须按会话存（2026-09-22 修，审计 P1）：服务端允许多回合并行（`appServer` 的 `activeTurns` 是
   * Set），但此前这里是两个**单字段**（`currentCancel` / `currentPersister`），每个新回合都覆盖写、
   * `finally` 里置空 ⇒ ① 先结束的回合会把令牌清掉，导致「停止」按钮**静默失效**；
   * ② 未结束时会话调用取消，取消的是**后启动的那个会话**（停 A 实际停了 B）。
   */
  private readonly runningSessions = new Map<
    string,
    { readonly cancel: CancellationToken; readonly persister: EventPersister }
  >();
  /** T5.4 技能稀疏化器（D9：class 形态；预算/豁免判据见 SkillSparsifier）。 */
  private readonly skillSparsifier = new SkillSparsifier({
    maxSkills: SKILL_SPARSE_MAX,
    minKeepScore: SKILL_SPARSE_MIN_KEEP,
  });
  /** 技能注册表（受种技能的匹配与渲染来源；缺省取运行时那一份，见构造函数）。 */
  private readonly skills: SkillRegistry | undefined;

  public constructor(
    /** 运行时组合根：提供模型、工具、审批、沙箱、存储、事件总线等全部依赖。 */
    private readonly runtime: OmniHarnessRuntime,
    /** 可选技能注册表：会话启动时按 prompt 匹配命中技能，渲染为 system 事件注入。 */
    skills?: SkillRegistry,
  ) {
    // 缺省取**运行时组合根里那一份**（`ResolvedConfig.skillRegistry`，由 `assembleSkillStack` 装配）。
    //
    // 为什么必须在这里兜底，而不是要求每个调用点显式传：实测 11 个 `new Agent(runtime)` 调用点里
    // **只有 1 个**（server 的 agentRuntimeHost）传了技能注册表 ⇒ 配置文件/CLI 受种的技能在
    // CLI、子代理、工作流、eval 等全部路径上**从不注入**（声明支持、全链路静默失效）。
    // 默认取运行时这份之后，任何新增调用点都不会再漏，也不需要各自记住这件事。
    this.skills = skills ?? runtime.config.skillRegistry;
  }

  /**
   * 取消在跑任务（V2）：模型在飞请求被中断（CancelledError 上抛），已产生事件仍经 finally 落盘。
   *
   * @param reason 取消原因，透传给取消令牌并随事件落盘（默认 'user'）。
   * @param sessionId 目标会话；**缺省时取消全部在跑会话**（CLI 单会话语义不变，服务端应显式传 threadId，
   *   否则并发回合下会误伤其它会话——2026-09-22 修）。
   * @returns 无返回值。
   */
  public cancelCurrentRun(
    reason: 'user' | 'timeout' | 'shutdown' | { readonly custom: string } = 'user',
    sessionId?: string,
  ): void {
    if (sessionId !== undefined) {
      this.runningSessions.get(sessionId)?.cancel.cancel(reason);
      return;
    }
    for (const session of this.runningSessions.values()) {
      session.cancel.cancel(reason);
    }
  }

  /**
   * 当前在跑会话 id（观测/测试用；顺序为插入顺序）。
   * @returns 会话 id 数组
   */
  public runningSessionIds(): string[] {
    return [...this.runningSessions.keys()];
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
      // 开场注入（技能 + 可选长期记忆 primer）：判重与理由见 injectSessionPreamble。
      this.injectSessionPreamble(recorder, eventLog, prompt, sessionId);
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
      recorder.user(effectivePrompt, images, files);
      // V2：会话级取消令牌（贯穿模型请求 fetch）+ 增量持久化器（write-behind），按 sessionId 登记。
      const cancel = new CancellationToken();
      const persister = new EventPersister(this.runtime.storage, sessionId, () => eventLog.all());
      const sessionEntry = { cancel, persister };
      this.runningSessions.set(sessionId, sessionEntry);
      const runner = this.buildTurnRunner(recorder, cancel, persister);
      let outcome: TurnOutcome;
      let persistedAt = 0;
      try {
        outcome = await runner.run(this.contextOf(sessionId));
      } finally {
        // 只清理**自己**那一格：并发回合若复用同一 sessionId（不该发生，但防御），不误删他人的登记。
        if (this.runningSessions.get(sessionId) === sessionEntry) {
          this.runningSessions.delete(sessionId);
        }
        // V2：回合内 write-behind 定时器已由 TurnRunner 收尾 flush+dispose；
        // 此处兜底：无论回合成功还是抛出（模型 500 / 网络中断 / 工具异常 / 取消），
        // 已产生的事件都必须落盘。旧行为是异常直接冒泡、save 被跳过——用户重进
        // 会话看到一片空白，等于历史凭空消失。save 自身失败只告警：绝不能用
        // 持久化错误掩盖原始异常。
        persister.dispose();
        persistedAt = eventLog.size();
        await this.persist(sessionId, eventLog.all());
        // 观测端口收尾：有缓冲的端口（OTLP span 收集器）在此把最后一批 span 外发；
        // 无缓冲端口未实现 flush，`?.` 使其零成本跳过。失败不掩盖原始异常（fail-soft）。
        await this.runtime.events.flush?.();
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
   
 * @returns 无返回值。
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
   * @param log 事件日志（含 hydrate 进来的历史）：用于判断某条技能文本是否已注入过。
   
 * @returns 无返回值。
*/
  private injectSkills(recorder: SessionRecorder, prompt: string, log: AppendOnlyEventLog): void {
    if (this.skills === undefined) {
      return;
    }
    // T5.4 技能稀疏化：按命中强度保留 top-k（名字命中级强命中豁免），剪标签级弱命中长尾，
    // 降低上下文噪声；预算与豁免判据见 skillSparsifier（确定性，无随机源）。
    const matched = this.skills.match(prompt);
    const sparse = this.skillSparsifier.sparsify(matched, prompt.toLowerCase());
    // 逐条判重（判重点是「保留每回合匹配」而非「一会话只算一次」）：同一条技能文本不重复注入，
    // 但任务转向后新命中的技能仍会注入——任务能力不因判重而丢。
    const seen = Agent.injectedContents(log);
    for (const skill of sparse.kept) {
      const rendered = this.skills.render(skill);
      if (seen.has(rendered)) continue;
      recorder.system(rendered);
    }
  }

  /**
   * 收集历史里已注入过的 system 文本（判重用的集合）。
   * @param log 事件日志
   * @returns 已注入的 system 文本集合（空串不计）
   */
  private static injectedContents(log: AppendOnlyEventLog): ReadonlySet<string> {
    const out = new Set<string>();
    for (const event of log.byType('system')) {
      const payload = event.payload as { content?: unknown } | null | undefined;
      const content = payload === null || payload === undefined ? undefined : payload.content;
      if (typeof content === 'string' && content !== '') out.add(content);
    }
    return out;
  }

  /**
   * 会话开场注入：技能（命中才注入）+ 可选长期记忆 primer，**每会话只注入一次**（不是每回合）。
   *
   * 缺陷背景（2026-09-19 实测）：`resume`/`fork` 会先 `hydrate` 历史，而注入原先无条件执行
   * ⇒ 同一段技能指令在长会话里出现 N 次（第 3 轮就有 3 份）。后果两层：① 上下文与 token 白烧
   * （每轮多一份重复 system）；② 模型反复读到同样的「规则」，反而稀释注意力。
   *
   * 判据：技能按**逐条渲染文本**判重（`SkillRegistry.render` 的完整产物，同技能⇒同文本），
   * 保留每回合重新匹配的能力；primer 按内容特征前缀 {@link MEMORY_PRIMER_MARKER} 判重。
   * 故改渲染格式必须同步这条前缀常量（有单测钉住注入次数）。
   *
   * primer 默认关闭：它会把跨会话 fact 拼成开场 system，模型常在首条回复照原文复述，
   * 对终端用户造成「被系统重复念」的噪声。需要时用 `OMNI_MEMORY_PRIMER=1` 显式启用。
   *
   * @param recorder 会话记录器（注入经其写为 system 事件）
   * @param log 事件日志（resume/fork 时已 hydrate 历史，用于判重）
   * @param prompt 本回合用户指令（技能匹配的输入）
   * @param sessionId 会话 ID（记忆 primer 用它排除本会话刚沉淀的事实）
   * @returns 无返回值
   */
  private injectSessionPreamble(
    recorder: SessionRecorder,
    log: AppendOnlyEventLog,
    prompt: string,
    sessionId: string,
  ): void {
    // 技能：**每回合都按 prompt 重新匹配**，但逐条按渲染文本判重（见 injectSkills），
    // 故既不会重复堆同一段指令，也不会因「历史里已有技能」而漏掉本回合新命中的技能。
    this.injectSkills(recorder, prompt, log);
    if (process.env.OMNI_MEMORY_PRIMER === '1' && !Agent.hasInjection(log, MEMORY_PRIMER_MARKER)) {
      this.injectMemoryPrimer(recorder, prompt, sessionId);
    }
  }

  /**
   * 历史里是否已存在某类 system 注入（按内容的特征前缀判定）。
   *
   * 为什么用「内容前缀」而不是另加事件类型/字段：注入产物是对模型可见的 system 文本，其特征前缀
   * 就是它与其它 system 事件（如 repo-map 尾注）的区分点；新增事件类型会牵动事件 schema 与所有
   * 消费方（UI/持久化/审计），而本判定的唯一用途是「别重复注入」。
   * @param log 事件日志（resume/fork 时已 hydrate 历史）
   * @param marker 内容特征前缀（见 {@link SKILL_MARKER} / {@link MEMORY_PRIMER_MARKER}）
   * @returns 已存在同类注入则 true
   */
  private static hasInjection(log: AppendOnlyEventLog, marker: string): boolean {
    return log.byType('system').some((event) => {
      const payload = event.payload as { content?: unknown } | null | undefined;
      const content = payload === null || payload === undefined ? undefined : payload.content;
      return typeof content === 'string' && content.startsWith(marker);
    });
  }

  /**
   * 会话开始注入长期记忆 primer（#4.2 读取策略）：把跨会话沉淀的 durable fact
   * 以 system 事件注入开场上下文，使模型开工前先对齐既有偏好/约定/决策/坑。
   * 用开场 prompt 做相关性召回；无命中时退化为按重要度取 top-N，确保始终有基线对齐。
   * 零侵入核心循环：仅为 recorder 追加一条 system 事件，不改变既有执行流。
   * @param recorder 会话记录器，primer 文本经其写为 system 事件。
   * @param prompt 开场用户 prompt，作为相关性召回的查询文本。
   * @param sessionId 当前会话 ID，用于过滤本会话刚沉淀的事实（避免自指回灌）。
   
 * @returns 无返回值。
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
  private buildTurnRunner(
    recorder: SessionRecorder,
    cancel: CancellationToken,
    persister: EventPersister,
  ): TurnRunner {
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
      // P5 自动降档：预算计量桥成的只读端口；非空且置位时 StepContextBuilder 收敛检索预算。
      budgetDegrade: this.runtime.budgetDegrade,
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
      Agent.buildLoopGuard(),
      // 增量持久化器：EventPersister 由 continueSession 创建并管理生命周期，
      // TurnRunner 只在每步调 schedule()——但构造签名要实例，故由调用方显式传入
      // （2026-09-22：不再读 `this.currentPersister` 单字段，避免并发回合互相覆盖）。
      persister,
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
      // P2（打磨）：确定性无损收缩显式透传（配置缺省即 true），杜绝「声明未接线」死旋钮。
      deterministicShrink: this.runtime.config.compactionDeterministicShrink ?? true,
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
   
 * @returns 无返回值。
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
   
 * @returns 无返回值。
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
  /**
   * buildLoopGuard — module-level helper moved into Agent.
   * @returns {LoopGuard} - result
   */
  private static buildLoopGuard(): LoopGuard {
    if (process.env.OMNI_LOOPGUARD === '0') {
      return new LoopGuard({ maxExactRepeats: 0, cycleWindow: 0 });
    }
    const maxMs = Number(process.env.OMNI_LOOP_MAX_MS);
    return new LoopGuard({
      maxDurationMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0,
    });
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
