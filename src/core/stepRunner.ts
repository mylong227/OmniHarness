import type { ToolContext, ToolCall, ToolDefinition } from '../ports/tool/tool.ts';
import type {
  ModelContextSnapshot,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelUsage,
} from '../ports/model/model.ts';
import { ModelFinishReasons } from '../util/modelFinishReasons.ts';
import { ModelCallError } from '../errors/modelCallError.ts';
import { ContextBreakdownEstimator } from '../context/contextBreakdownEstimator.ts';
import { StepContextBuilder } from './stepContextBuilder.ts';
import { StepToolExecutor } from './stepToolExecutor.ts';
import type { StepRunnerDeps, StepOutcome } from './stepTypes.ts';
import type { LoopResultObservation } from './loop/loopGuard.ts';
import { log } from '../util/logger.ts';

/** 单步运行依赖（全部来自端口）。定义已迁至 `stepTypes.ts`，此处再导出以稳定公共 API。 */
export type { StepRunnerDeps } from './stepTypes.ts';

/** 单步结果类型：产出了文本 / 发起了工具调用 / 空响应。 */
export type { StepOutcome } from './stepTypes.ts';

/**
 * 单步执行器：一次模型请求 + 经 审批→沙箱→执行 链路的工具调用。
 *
 * P6.3 职责缝拆分后，本类**只负责编排**，两个协作者各承担一件事：
 *  - 上下文组装（常驻指令 / repo-map / 压缩游标）→ {@link StepContextBuilder}
 *  - 工具调用链路（门禁 → pre → 执行 → post → 记录）→ {@link StepToolExecutor}
 *
 * 导出路径、构造签名与公开成员（`run` / `finalize` / `usageOfLastStep` / `toolCallsOfLastStep`）
 * 一律不变，调用点零改动。
 */
export class StepRunner {
  private readonly contextBuilder: StepContextBuilder;
  private readonly toolExecutor: StepToolExecutor;
  /** 上下文容量分解器：在发请求的同一位置对「实际送出的消息 + 工具」取实测快照。 */
  private readonly breakdown = new ContextBreakdownEstimator();
  /** 本步模型发出的工具调用（V2 失控检测观测用；text/empty 步为空数组）。 */
  private lastToolCalls: readonly ToolCall[] = [];
  /** 本步工具结果（LoopGuard 的 `redundant-result` 检测用；无工具步为空数组）。 */
  private lastToolResults: readonly LoopResultObservation[] = [];
  /** 本步模型用量（V2.1 token 预算终止用；模型未上报时为 undefined）。 */
  private lastUsage: ModelUsage | undefined;
  /** 本步实际送出上下文的占用快照（随 model 事件落日志，UI 容量面板读实测值）。 */
  private lastContext: ModelContextSnapshot | undefined;
  /** 本步实际使用的模型名（fallback 时可能不同于主模型；LR-04）。 */
  private lastModelName: string;

  /** 本步模型用量（TurnRunner 预算累计读；无 usage 的模型恒 undefined）。 */
  public get usageOfLastStep(): ModelUsage | undefined {
    return this.lastUsage;
  }

  /** 本步上下文占用快照（诊断/单测用；本步未发请求时为 undefined）。 */
  public get contextOfLastStep(): ModelContextSnapshot | undefined {
    return this.lastContext;
  }

  /** 最近一步的工具调用（LoopGuard 观测入口；无工具步为空数组）。 */
  public get toolCallsOfLastStep(): readonly ToolCall[] {
    return this.lastToolCalls;
  }

  /** 最近一步的工具结果（LoopGuard 冗余取回检测；无工具步为空数组）。 */
  public get toolResultsOfLastStep(): readonly LoopResultObservation[] {
    return this.lastToolResults;
  }

  /**
   * 从事件日志尾部取回本步工具结果（只读、不复制正文之外的结构）。
   *
   * 为什么不改 `StepToolExecutor.run` 的返回值：工具结果在**执行时**已由执行器记录，
   * 这里只做一次「按 callId 对齐」的尾部扫描——不侵入审批/沙箱/钩子那条链路，
   * 也不改变执行器「记录即配对」的既有不变量。最坏 O(历史事件数)，但正常情况下
   * 目标结果就在最后几条事件里，扫到即停。
   *
   * @param calls 本步的模型工具调用。
   * @returns 按 callId 去重后的结果观测（顺序为事件顺序的逆序，语义上无所谓）。
   */
  private collectToolResults(calls: readonly ToolCall[]): LoopResultObservation[] {
    if (calls.length === 0) return [];
    const names = new Map(calls.map((call) => [call.id, call.name]));
    const events = this.deps.recorder.allEvents();
    const seen = new Set<string>();
    const results: LoopResultObservation[] = [];
    for (let i = events.length - 1; i >= 0 && results.length < calls.length; i -= 1) {
      const event = events[i];
      if (event === undefined || event.type !== 'tool_result') continue;
      const payload = event.payload as { callId?: string; ok?: boolean; output?: string };
      const callId = payload.callId;
      if (callId === undefined || !names.has(callId) || seen.has(callId)) continue;
      seen.add(callId);
      results.push({
        name: names.get(callId) ?? '?',
        ok: payload.ok === true,
        output: typeof payload.output === 'string' ? payload.output : '',
      });
    }
    return results;
  }

  /**
   * @param deps 单步依赖契约（见 `StepRunnerDeps`）；本类直接消费 model / recorder / live /
   *   signal / reasoningEffort，其余字段转发给两个协作者。
   */
  public constructor(private readonly deps: StepRunnerDeps) {
    this.contextBuilder = new StepContextBuilder(deps);
    this.toolExecutor = new StepToolExecutor(deps);
    this.lastModelName = deps.model.name;
  }

  /**
   * 运行一步。
   *
   * @param context 工具上下文（含 sessionId）。
   * @returns 本步产出：'tool'（发起了工具调用）/'text'（产出文本）/'empty'（空响应）。
   */
  public async run(context: ToolContext): Promise<StepOutcome> {
    const output = await this.requestModel();
    this.recordReasoning(output.reasoning);
    // 模型用量落事件流（#S29 / live 跑分成本计量）；无 usage 静默跳过，绝不臆造。
    // 带上模型名，供服务端 token 统计按模型分组；带上下文快照，供 UI 容量面板读实测分解
    // （快照在 requestModel 内取，与真正送出的 messages/tools 同源，不是事后重算）。
    // `lastUsage` 必须**无条件覆盖**：某步没有 usage 时若保留上一步的值，TurnRunner 会把它
    // 重复计入预算（提前熔断/多计费）。
    this.lastUsage = output.usage;
    if (output.usage !== undefined) {
      this.deps.recorder.usage(output.usage, this.lastModelName, this.lastContext);
    }
    if (output.toolCalls !== undefined && output.toolCalls.length > 0) {
      this.lastToolCalls = output.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      await this.toolExecutor.run(output.toolCalls, context);
      this.lastToolResults = this.collectToolResults(this.lastToolCalls);
      return 'tool';
    }
    this.lastToolCalls = [];
    this.lastToolResults = [];
    if (output.text !== undefined) {
      // 把模型同一回合的推理内容（DeepSeek v4 reasoning 模式输出）一并塞进 assistant 事件，
      // 不依赖 reasoning/assistant 事件流时序——避免下轮 HTTP 400（#OBS-5）。
      this.deps.recorder.assistant(output.text, output.reasoning);
      return 'text';
    }
    return 'empty';
  }

  /**
   * 步数耗尽兜底（#OBS-9）：做一次「无工具」模型调用，强制模型基于已有上下文
   * 直接产出最终答复。
   *
   * 场景：模型持续调用工具（探索/检索/验证）而从未输出文本，跑满 maxSteps 后
   * TurnRunner 退出、finalText 为 undefined，用户侧表现为「转了很久没有任何结果」。
   * 2026-09-08 真机复现：steps=16 / session.end hasText:false。
   *
   * 实现要点：
   *  - tools 传空数组，模型无法再调工具，只能输出文本；
   *  - 末尾追加一条显式 user 指令，避免模型回「需要更多信息」继续空转；
   *  - 产出的文本经 recorder.assistant 入事件流，UI 与 threads.get 都能取到；
   *  - 全程 fail-closed：任何异常都吞掉返回 undefined，绝不阻断主流程。
   *
   * @returns 兜底产出的文本；模型仍无输出或异常时为 undefined。
   */

  public async finalize(): Promise<string | undefined> {
    try {
      const base = await this.contextBuilder.buildMessages();
      const messages: ModelMessage[] = [
        ...base,
        {
          role: 'user',
          content:
            '【系统提示】本回合即将结束（预算/行为护栏/显式步数上限之一触发），现在**不要再调用工具**。' +
            '请按顺序做两件事：① 把**已经完成但尚未落盘**的改动逐条写清——文件路径 + 完整内容或补丁；' +
            '② 再给出结论与剩余工作。**不要让已做的分析只停留在文字里**：下一步会照这份交接直接落盘。',
        },
      ];
      // 取消信号透传：`finalize` 是「跑满 maxSteps」时的必然路径，恰恰是已经烧完一整轮 token、
      // 用户最想中断的时刻。原先这里拿不到 signal，也无法经 `RequestStallGuard` 转发外部信号
      // （2026-10-01 审计），于是「停止」按钮在收尾阶段形同虚设。
      const request = {
        messages,
        tools: [],
        reasoningEffort: this.deps.reasoningEffort,
        signal: this.deps.signal,
        role: 'executor' as const,
      };
      log.info('step.finalize', { messageCount: messages.length });
      const stream = this.deps.model.stream;
      const output =
        stream !== undefined
          ? await stream.call(this.deps.model, request, { onText: () => {} })
          : await this.deps.model.generate(request);
      if (output.usage !== undefined) {
        this.deps.recorder.usage(output.usage, this.deps.model.name);
      }
      const text = output.text;
      if (text === undefined || text.trim() === '') return undefined;
      this.deps.recorder.assistant(text, output.reasoning);
      return text;
    } catch (error) {
      // 兜底收尾失败必须**留痕**：吞掉异常后本回合会以「没有任何输出」结束，用户与事后排障都
      // 看不到原因（本文件其他失败路径均有日志，唯独这里没有）。
      log.warn('step.finalize.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 请求模型（上下文从事件日志投影，超预算先压缩）。
   * #B3：若 live 端口非空且模型支持 stream，走流式并在 onToolInput 回调里把工具参数增量
   * 转发给 live 端口供 UI 实时渲染；否则退回原 generate 路径（行为逐字节一致，fail-closed）。
   *
   * @returns 模型输出（推理 / 文本 / 工具调用 / 用量）。
   */
  private async requestModel(): Promise<ModelOutput> {
    // 先算工具集再组装消息：`buildMessages` 要拿它当**每请求固定开销**（工具 schema 与
    // 消息共用同一 token 预算），否则压缩判据看不到 schema 占用，长会话会越过真实窗口才压缩。
    // 两件事互不依赖（工具集只读注册表/发现寄存器，不读事件），调序无行为差异。
    const tools = this.contextBuilder.effectiveTools();
    let messages = await this.contextBuilder.buildMessages({ tools });
    this.lastContext = this.snapshotOf(messages, tools);
    let output = await this.invokeWithRecovery(messages, tools);
    // CTX-02（2026-10-21）：首次请求的 usage 与 `lastContext` 同源，喂给校准器。
    // 续写/回退后的多次调用**不重复喂**（merged usage 的 promptTokens 会累加，
    // 与单次估算不同源，喂进去会系统性抬高 factor）。
    this.observeCalibration(output.usage);
    let text = output.text;
    let reasoning = output.reasoning;
    let usage = output.usage;
    let finishReason = ModelFinishReasons.normalize(output.finishReason);
    const maxRecoveries = Math.max(0, this.deps.maxOutputRecoveries ?? 3);
    let recoveries = 0;
    // LR-02：输出被截断（`length` / `max_tokens` 等厂商字面量）时续写，而不是把半截当完成。
    // 半截 tool_calls 不执行；恢复层只认归一化后的统一值，适配器已在边界完成归一化，
    // 这里再用 `isTruncated` 兜底第三方适配器（2026-10-21）。
    while (ModelFinishReasons.isTruncated(finishReason) && recoveries < maxRecoveries) {
      const partial = text ?? '';
      if (partial.trim() === '' && output.toolCalls === undefined) {
        break;
      }
      recoveries += 1;
      log.warn('model.output.truncated', { recoveries, maxRecoveries });
      this.deps.recorder.system(
        `【输出截断】模型输出达到 token 上限，正在续写（${String(recoveries)}/${String(maxRecoveries)}）。`,
      );
      const continuation: ModelMessage[] = [
        ...messages,
        { role: 'assistant', content: partial },
        {
          role: 'user',
          content:
            'Output token limit hit. Resume directly from the exact point where you stopped. ' +
            'Do not repeat completed work and do not restate the plan; continue the same deliverable.',
        },
      ];
      messages = continuation;
      const next = await this.invokeWithRecovery(messages, tools);
      text = StepRunner.joinText(text, next.text);
      reasoning = StepRunner.joinReasoning(reasoning, next.reasoning);
      usage = StepRunner.mergeUsage(usage, next.usage);
      finishReason = ModelFinishReasons.normalize(next.finishReason);
      output = next;
    }
    if (ModelFinishReasons.isTruncated(finishReason)) {
      // 续写次数用尽仍截断：如实保留 finishReason，但**绝不执行半截工具调用**（参数可能不完整）。
      log.warn('model.output.truncated_exhausted', { recoveries, maxRecoveries });
      this.deps.recorder.system(
        '【输出截断】续写次数已用尽，输出仍不完整；本步不执行任何半截工具调用，请缩小任务或提高输出上限。',
      );
      output = { ...output, toolCalls: undefined };
    }
    return {
      ...output,
      ...(text !== undefined ? { text } : {}),
      ...(reasoning !== undefined && reasoning !== '' ? { reasoning } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  /**
   * 带恢复的模型调用（LR-03 / LR-04）：
   *  - 400 `prompt_too_long` ⇒ 强制压缩一轮后重试（只重试一次，避免死循环）；
   *  - 529/503 过载 ⇒ 若配置了备用模型，切到备用模型重试一次；
   *  - 其它错误原样上抛（fail-closed）。
   *
   * @param messages 本次请求消息。
   * @param tools 本次可见工具。
   * @returns 模型输出。
   */
  private async invokeWithRecovery(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<ModelOutput> {
    try {
      return await this.invoke(this.deps.model, messages, tools);
    } catch (error) {
      if (StepRunner.isPromptTooLong(error) && this.deps.compactor !== undefined) {
        log.warn('model.context_overflow.recovering', { messageCount: messages.length });
        this.deps.recorder.system('【上下文超窗】端点拒绝请求，正在强制压缩后重试。');
        const forced = await this.contextBuilder.buildMessages({ tools }, true);
        this.lastContext = this.snapshotOf(forced, tools);
        return await this.invoke(this.deps.model, forced, tools);
      }
      if (StepRunner.isOverload(error) && this.deps.fallbackModel !== undefined) {
        log.warn('model.overload.fallback', { fallback: this.deps.fallbackModel.name });
        this.deps.recorder.system(
          `【模型过载】主模型不可用，切换到备用模型 ${this.deps.fallbackModel.name} 重试。`,
        );
        return await this.invoke(this.deps.fallbackModel, messages, tools);
      }
      throw error;
    }
  }

  /**
   * 单次模型调用（流式/非流式二选一）。
   * @param model 本次使用的模型端口（可能是 fallback）。
   * @param messages 请求消息。
   * @param tools 可见工具。
   * @returns 模型输出。
   */
  private async invoke(
    model: ModelPort,
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<ModelOutput> {
    this.lastModelName = model.name;
    log.debug('model.request', {
      messageCount: messages.length,
      toolCount: tools.length,
      model: model.name,
    });
    const request = {
      messages,
      tools,
      reasoningEffort: this.deps.reasoningEffort,
      // 单次输出上限：未配置时为 undefined（适配器不发 max_tokens，保持端点默认）。
      maxOutputTokens: this.deps.maxOutputTokens,
      // V2：取消信号透传（未注入为 undefined，适配器行为不变）。
      signal: this.deps.signal,
      role: 'executor' as const,
    };
    const stream = model.stream;
    if (this.deps.live !== undefined && stream !== undefined) {
      return stream.call(model, request, {
        // V2.1：文本增量转发给 live sink（--stream-text 时打到 stdout）；无消费方即丢弃，行为不变。
        onText: (text) => this.deps.live!.onTextDelta?.(text),
        onToolInput: (delta) => this.deps.live!.onToolInput(delta),
      });
    }
    return model.generate(request);
  }

  /**
   * 是否为 prompt-too-long 类 400（LR-03）。
   * @param error 抛出的错误。
   * @returns 命中时为 true。
   */
  private static isPromptTooLong(error: unknown): boolean {
    if (!(error instanceof ModelCallError) || error.status !== 400) return false;
    const text = `${error.message}\n${error.responseBody ?? ''}`;
    return /prompt.{0,12}too.{0,12}long|context.{0,12}(length|window).{0,12}(exceed|too|max)|maximum context|too many tokens|input.{0,12}too.{0,12}long/i.test(
      text,
    );
  }

  /**
   * 是否为过载类错误（LR-04）。
   * @param error 抛出的错误。
   * @returns 命中时为 true。
   */
  private static isOverload(error: unknown): boolean {
    return error instanceof ModelCallError && (error.status === 529 || error.status === 503);
  }

  /**
   * 合并两段文本（任一段为空时保留另一段）。
   * @param a 第一段。
   * @param b 第二段。
   * @returns 合并文本。
   */
  private static joinText(a: string | undefined, b: string | undefined): string | undefined {
    if (a === undefined || a === '') return b;
    if (b === undefined || b === '') return a;
    return `${a}${b}`;
  }

  /**
   * 合并两段推理文本（换行分隔，避免粘成一个词）。
   * @param a 第一段。
   * @param b 第二段。
   * @returns 合并推理文本。
   */
  private static joinReasoning(a: string | undefined, b: string | undefined): string | undefined {
    if (a === undefined || a === '') return b;
    if (b === undefined || b === '') return a;
    return `${a}\n${b}`;
  }

  /**
   * 合并两段用量（续写/fallback 后成本要累加，不能只记最后一次）。
   * @param a 第一段用量。
   * @param b 第二段用量。
   * @returns 合并用量。
   */
  private static mergeUsage(
    a: ModelUsage | undefined,
    b: ModelUsage | undefined,
  ): ModelUsage | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    const cached =
      a.cachedPromptTokens === undefined && b.cachedPromptTokens === undefined
        ? undefined
        : (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0);
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
      ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    };
  }

  /**
   * 取本次请求的上下文占用快照。
   *
   * 窗口大小取自 `deps.contextWindowTokens`（组合根按 env / 厂商表解析后注入）；
   * 未注入时记为 0——快照仍可读（各类 token 数有效），只是「占窗口百分比」无处可算，
   * 读取侧据此显示为未知，绝不拿一个假窗口凑数。
   *
   * @param messages 本次发出的模型消息（与请求体同一数组）
   * @param tools 本次发出的工具定义
   * @returns 紧凑快照（分类 token 数 + 工具计数 + 窗口）
   */
  /**
   * 把「本地估算 vs 端点实际 promptTokens」喂给校准器（CTX-02，2026-10-21）。
   *
   * 只记录、不改本步行为；压缩器读同一实例的 factor 修正自动窗口阈值。
   * @param usage 本步模型用量（无 usage 时跳过）。
   * @returns 无返回值。
   */
  private observeCalibration(usage: ModelUsage | undefined): void {
    const calibrator = this.deps.calibrator;
    const estimated = this.lastContext?.usedTokens;
    if (
      calibrator === undefined ||
      usage === undefined ||
      estimated === undefined ||
      estimated <= 0 ||
      usage.promptTokens <= 0
    ) {
      return;
    }
    calibrator.observe({ estimated, actual: usage.promptTokens });
    const report = calibrator.report();
    log.debug('context.token_calibration', {
      samples: report.samples,
      medianErrorPct: Number(report.medianErrorPct.toFixed(2)),
      p90ErrorPct: Number(report.p90ErrorPct.toFixed(2)),
      factor: Number(report.factor.toFixed(4)),
    });
  }

  /**
   * 取本步实际送出上下文的快照（估算 token / 工具计数 / 前缀复用率）。
   * @param messages 本轮消息。
   * @param tools 本轮可见工具。
   * @returns 上下文快照。
   */
  private snapshotOf(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
  ): ModelContextSnapshot {
    const breakdown = this.breakdown.estimate({
      messages,
      tools,
      baseFragmentCount: this.deps.fragments?.length ?? 0,
      windowTokens: this.deps.contextWindowTokens ?? 0,
    });
    const snapshot = this.breakdown.snapshotOf(breakdown);
    // 前缀复用率随快照一起落日志：它是"缓存为什么没命中"在**本机可控面**上的唯一信号
    // （容量面板的分因读它）。首次请求没有基准 ⇒ 字段缺省，读取侧必须把"未知"与"0"分开。
    const reuse = this.contextBuilder.prefixReuseRatioOfLastBuild;
    return reuse === undefined ? snapshot : { ...snapshot, prefixReuseRatio: reuse };
  }

  /**
   * 记录推理轨迹（空串与非字符串静默跳过）。
   *
   * @param reasoning 模型本步产出的推理文本（可选）。
   * @returns 无返回值。
   */
  private recordReasoning(reasoning: string | undefined): void {
    if (reasoning !== undefined && reasoning !== '') {
      this.deps.recorder.reasoning(reasoning);
    }
  }
  /**
   * 回滚后重新对齐压缩游标（透传给 {@link StepContextBuilder.rewindCompactionState}）。
   * @returns 无返回值。
   */
  public rewindCompactionState(): void {
    this.contextBuilder.rewindCompactionState();
  }
}
