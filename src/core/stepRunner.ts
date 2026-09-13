import type { ToolContext, ToolCall, ToolDefinition } from '../ports/tool/tool.js';
import type {
  ModelContextSnapshot,
  ModelMessage,
  ModelPort,
  ModelUsage,
} from '../ports/model/model.js';
import { ContextBreakdownEstimator } from '../context/contextBreakdownEstimator.js';
import { StepContextBuilder } from './stepContextBuilder.js';
import { StepToolExecutor } from './stepToolExecutor.js';
import type { StepRunnerDeps, StepOutcome } from './stepTypes.js';
import { log } from '../util/logger.js';

/** 单步运行依赖（全部来自端口）。定义已迁至 `stepTypes.ts`，此处再导出以稳定公共 API。 */
export type { StepRunnerDeps } from './stepTypes.js';

/** 单步结果类型：产出了文本 / 发起了工具调用 / 空响应。 */
export type { StepOutcome } from './stepTypes.js';

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
  /** 本步模型用量（V2.1 token 预算终止用；模型未上报时为 undefined）。 */
  private lastUsage: ModelUsage | undefined;
  /** 本步实际送出上下文的占用快照（随 model 事件落日志，UI 容量面板读实测值）。 */
  private lastContext: ModelContextSnapshot | undefined;

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

  /**
   * @param deps 单步依赖契约（见 `StepRunnerDeps`）；本类直接消费 model / recorder / live /
   *   signal / reasoningEffort，其余字段转发给两个协作者。
   */
  public constructor(private readonly deps: StepRunnerDeps) {
    this.contextBuilder = new StepContextBuilder(deps);
    this.toolExecutor = new StepToolExecutor(deps);
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
    if (output.usage !== undefined) {
      this.deps.recorder.usage(output.usage, this.deps.model.name, this.lastContext);
      // V2.1：缓存本步用量供 TurnRunner 做 token 预算终止（B4）。
      this.lastUsage = output.usage;
    }
    if (output.toolCalls !== undefined && output.toolCalls.length > 0) {
      this.lastToolCalls = output.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      await this.toolExecutor.run(output.toolCalls, context);
      return 'tool';
    }
    this.lastToolCalls = [];
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
            '【系统提示】工具调用步数已达上限。请立即基于上文中已经获得的所有信息，' +
            '直接给出最终答复与结论；不要再请求调用任何工具，也不要说需要更多信息。',
        },
      ];
      const request = { messages, tools: [], reasoningEffort: this.deps.reasoningEffort };
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
    } catch {
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
  private async requestModel(): Promise<ReturnType<ModelPort['generate']>> {
    const messages = await this.contextBuilder.buildMessages();
    const tools = this.contextBuilder.effectiveTools();
    this.lastContext = this.snapshotOf(messages, tools);
    log.debug('model.request', { messageCount: messages.length, toolCount: tools.length });
    const stream = this.deps.model.stream;
    const request = {
      messages,
      tools,
      reasoningEffort: this.deps.reasoningEffort,
      // V2：取消信号透传（未注入为 undefined，适配器行为不变）。
      signal: this.deps.signal,
    };
    if (this.deps.live !== undefined && stream !== undefined) {
      return stream.call(this.deps.model, request, {
        // V2.1：文本增量转发给 live sink（--stream-text 时打到 stdout）；无消费方即丢弃，行为不变。
        onText: (text) => this.deps.live!.onTextDelta?.(text),
        onToolInput: (delta) => this.deps.live!.onToolInput(delta),
      });
    }
    return this.deps.model.generate(request);
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
    return this.breakdown.snapshotOf(breakdown);
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
}
