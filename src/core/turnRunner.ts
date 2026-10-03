import type { ToolContext } from '../ports/tool/tool.js';
import type { CompletionGate, VerificationState } from '../ports/runtime/completionGate.js';
import { BudgetExceededError } from '../ports/model/model.js';
import type { StepRunner, StepOutcome } from './stepRunner.js';
import type { SessionRecorder } from './sessionRecorder.js';
import type { TurnDiffTrackerPort } from '../ports/runtime/turnDiffTracker.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import type { MemoryExtractorPort } from '../ports/memory/memoryExtractor.js';
import { LoopGuard, type LoopDecision } from './loop/loopGuard.js';
import type { EventPersister } from './loop/eventPersister.js';
import { log } from '../util/logger.js';

// 完成闸门契约已下沉到 `ports/runtime/completionGate.ts`（2026-09-27，修架构违规：契约留在 core
// 会逼适配器 import core）。此处原路径**继续导出**，保持既有公共 API 面不变。
export type { CompletionGate } from '../ports/runtime/completionGate.js';

/** 回合运行结果。 */
export interface TurnOutcome {
  readonly steps: number;
  readonly finalText?: string | undefined;
  /** 本回合累计模型 token 用量（V2.1；模型未上报 usage 时为 0）。 */
  readonly usageTokens: number;
  /** 是否因**步数耗尽**而收尾（未自然收敛）——调用方据此区分「完成」与「被截断」。 */
  readonly truncated: boolean;
  /** 是否因**失控熔断**而中断（同属「没做完」）。 */
  readonly aborted: boolean;
  /**
   * 本回合的**验证状态**（G3-V2，2026-10-03）：`not-run` / `failed` / `unverified`。
   *
   * 存在理由：完成闸门每回合至多跑一次，二次宣告完成会被放行——若不给这个字段，
   * 上层（子代理 / 工作流 / UI）只能把"放行"读成"验证通过"，正是假完成的落点。
   * `'unverified'` **不得**读成通过。缺省（undefined）＝ 未上报（兼容既有实现与测试）。
   */
  readonly verificationState?: VerificationState | undefined;
}

interface CompletionClaim {
  /** 完成闸门是否已用过（有界：每回合至多一次）。 */
  gated: boolean;
  /** 本回合的验证状态（G3-V2）；`unverified` 不得读成通过。 */
  verificationState: VerificationState;
}

/**
 * 连续空响应（模型既无文本也无工具调用）的重试上限。 * 设有限值：空响应重试是有界的，避免整份步数预算被空转烧光；
 * 达上限即退出并由兜底总结收尾。
 */
const MAX_CONSECUTIVE_EMPTY = 3;

/** 回合执行器：0..n 步，直到模型输出文本或步数耗尽。 */
export class TurnRunner {
  private readonly loopGuard: LoopGuard | undefined;

  public constructor(
    private readonly stepRunner: StepRunner,
    private readonly recorder: SessionRecorder,
    private readonly maxSteps: number,
    /** 回合级变更追踪器（#M5，可选）：回合结束时产出 unified diff 并广播。 */
    private readonly turnDiff?: TurnDiffTrackerPort | undefined,
    /** 长期记忆端口（#S28，可选）：回合末蒸馏沉淀的目的地。 */
    private readonly longTerm?: LongTermMemoryPort,
    /** 长期记忆蒸馏器（#S28，可选）：回合末把自上次以来的事件蒸馏为持久事实。 */
    private readonly extractor?: MemoryExtractorPort,
    /**
     * 失控检测器（V2，可选）：同调用重复/循环模式/wall-clock 检测。
     * 首次触发注入纠偏 user 消息（学 Varpulis additionalContext 模式），
     * 连续触达上限才熔断退出——不误杀长任务。
     */
    loopGuard?: LoopGuard,
    /**
     * 增量持久化器（V2，可选）：每步 write-behind 落盘（200ms 批量），
     * 回合末强 flush——崩溃最多丢一个窗口的事件，而非整回合。
     */
    private readonly persister?: EventPersister,
    /**
     * 回合 token 预算（V2.1，可选，0/缺省关闭）：累计模型 usage 超限即停止步进，
     * 交由兜底总结收尾——对标 codex 的 token 预算终止，比纯步数更贴近真实成本。
     */
    private readonly tokenBudget = 0,
    /**
     * 回合完成闸门（A1，可选）：模型声明「做完了」时核验本会话最近一次自验证结果；
     * 仍有失败则回灌并再给一步（**每回合至多一次**）。缺省 undefined＝不设闸门（旧行为）。
     */
    private readonly completionGate?: CompletionGate,
  ) {
    this.loopGuard = loopGuard;
  }

  /** 运行一个回合。 */

  public async run(context: ToolContext): Promise<TurnOutcome> {
    log.debug('turn.start', { maxSteps: this.maxSteps });
    // 标记回合起点：finalText 只认本回合产出的 assistant，避免 resume 时串到历史答案（#OBS-10）。
    this.recorder.markTurnStart();
    let steps = 0;
    let consecutiveEmpty = 0;
    let aborted = false;
    let usageTokens = 0;
    /** 本回合的完成判定状态（闸门是否已用过 + 验证状态）；用对象承载以便抽方法传引用。 */
    /** 本回合的完成判定状态（就地更新；用对象承载以便抽方法传引用）。 */
    const claim: CompletionClaim = { gated: false, verificationState: 'not-run' };
    while (steps < this.maxSteps) {
      // V2.1：成本预算熔断（B5 补全）——BudgetedModel 抛 BudgetExceededError 时
      // 不再让整回合硬崩（异常冒泡 → 用户颗粒无收），而是记录事件、跳出循环，
      // 交由下方 finalize 兜底总结，把已有进展交付给用户。
      let outcome: StepOutcome;
      try {
        outcome = await this.stepRunner.run(context);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          log.warn('turn.budget_exceeded', { steps, usageTokens });
          this.recorder.system('【预算熔断】模型调用成本已达硬预算上限，本回合停止步进。');
          break;
        }
        throw err;
      }
      steps += 1;
      // V2.1 token 预算累计（B4）：usage 缺失的模型不计入（绝不臆造）。
      const stepUsage = this.stepRunner.usageOfLastStep;
      if (stepUsage !== undefined) {
        usageTokens += stepUsage.totalTokens;
      }
      // V2 增量持久化：每步安排 write-behind 落盘（崩溃最多丢一个批量窗口）。
      this.persister?.schedule();
      // V2.1：token 预算超限 → 停止步进（finalize 会总结当前进展）。
      if (this.tokenBudget > 0 && usageTokens >= this.tokenBudget) {
        log.warn('turn.token_budget_reached', { steps, usageTokens, budget: this.tokenBudget });
        this.recorder.system(
          `【预算】本回合 token 用量（${usageTokens}）已达预算上限（${this.tokenBudget}），停止步进。`,
        );
        break;
      }
      if (outcome === 'tool') {
        consecutiveEmpty = 0;
        // V2 失控检测：观测本步工具调用，决定 放行/纠偏/熔断。
        if (this.observeLoopGuard()) {
          aborted = true;
          break;
        }
        continue;
      }
      if (outcome === 'text') {
        // 完成闸门（A1 + G3-V2）：抽成方法以守住本函数体上限，语义见其 JSDoc。
        if ((await this.handleCompletionClaim(claim, context.sessionId, steps)) === 'retry') {
          continue;
        }
        break;
      }
      // 'empty'：模型既没给文本也没调工具（空响应/被安全过滤/上游截断）。
      // 旧行为是一步即 break —— 一轮昂贵的工具探索后只要模型吐个空响应就整轮没结果。
      // 改为有限重试；连续空转达上限则止损（避免把整个步数预算烧在空响应上）。
      consecutiveEmpty += 1;
      log.warn('turn.empty_step', {
        step: steps,
        consecutiveEmpty,
        maxConsecutiveEmpty: MAX_CONSECUTIVE_EMPTY,
      });
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
        break;
      }
    }
    // #OBS-9：本回合未产出任何文本时（模型一直在调工具、或连续空响应、或失控熔断），
    // 做一次「无工具」兜底调用强制总结。否则 finalText 为 undefined，用户侧就是
    // 「转了很久没有结果」。判据是「本回合没有文本」而非退出路径——三种退出路径
    // （步数耗尽 / 空转止损 / 失控熔断）都需要兜底；正常收敛不多花这一次调用。
    let finalText = this.recorder.lastAssistantText();
    if (
      (finalText === undefined || finalText.trim() === '') &&
      typeof this.stepRunner.finalize === 'function'
    ) {
      const summary = await this.stepRunner.finalize();
      if (summary !== undefined && summary.trim() !== '') {
        finalText = summary;
      }
    }
    return this.closeTurn({
      steps,
      usageTokens,
      aborted,
      finalText,
      verificationState: claim.verificationState,
    });
  }

  /**
   * 处理「模型宣布完成」这一步：问一次完成闸门，决定回灌重试还是允许收尾。
   *
   * 有界性：闸门**每回合至多跑一次**（避免把步数预算烧在反复验证上）。因此二次宣告完成时无法再核验，
   * 只能放行——**但必须如实记 'unverified'**，否则上层会把"放行"读成"验证通过"（假完成的落点）。
   * @param claim 本回合的完成判定状态（就地更新）。
   * @param sessionId 会话 id。
   * @param steps 当前步数（用于日志）。
   * @returns 'retry' ＝ 已回灌失败摘要、继续步进；'close' ＝ 允许收尾。
   */
  private async handleCompletionClaim(
    claim: CompletionClaim,
    sessionId: string,
    steps: number,
  ): Promise<'retry' | 'close'> {
    const digest = claim.gated ? undefined : await this.completionDigest(sessionId);
    if (digest !== undefined && digest !== '') {
      claim.gated = true;
      claim.verificationState = 'failed';
      log.warn('turn.completion_gate.blocked', { steps, sessionId });
      this.recorder.user(
        '【完成闸门】你已声明完成，但本回合对源码的改动**验证未通过**：\n' +
          `${digest}\n` +
          '请先修好它再收尾；若你判断该失败与本次改动无关（例如环境缺失/既有失败），' +
          '请在结论里**逐条说明**是哪一条、依据是什么。',
      );
      return 'retry';
    }
    if (claim.gated) {
      claim.verificationState = 'unverified';
      log.warn('turn.completion_gate.unverified', { steps, sessionId });
      this.recorder.system(
        '【完成闸门】本回合以「未验证」状态收尾：验证曾失败一次、失败摘要已回灌，' +
          '但模型二次宣告完成时**未再核验**。请勿把本回合的"已完成"当作已验证事实。',
      );
    }
    return 'close';
  }

  /**
   * 回合收尾（观测 → 落盘 flush → diff 广播 → 记忆蒸馏 → 组装结果）。
   *
   * 抽出的动因有两层：① `run` 已达函数体上限；② 收尾语义（含「是否被截断」的判定）集中一处，
   * 避免以后再加退出路径时漏带状态。
   * @param summary 本回合的收尾事实（步数 / token 用量 / 是否熔断 / 最终文本）。
   * @returns 回合结果（含 `truncated` 标记：步数耗尽即未自然收敛）。
   */
  private async closeTurn(summary: {
    readonly steps: number;
    readonly usageTokens: number;
    readonly aborted: boolean;
    /** 本回合的验证状态（G3-V2）；`unverified` 不得读成通过。 */
    readonly verificationState?: VerificationState | undefined;
    readonly finalText: string | undefined;
  }): Promise<TurnOutcome> {
    log.info('turn.end', {
      steps: summary.steps,
      hasText: summary.finalText !== undefined,
      aborted: summary.aborted,
    });
    // V2：回合末强落盘 + 停止 write-behind 定时器（防泄漏）。
    if (this.persister !== undefined) {
      await this.persister.flush();
      this.persister.dispose();
    }
    this.emitTurnDiff();
    // 记忆蒸馏是 best-effort 后台任务（失败不致命，见 consolidateMemory 内部 try/catch）。
    // 异步化：不阻塞 turns.run 的 HTTP 响应——即便蒸馏因模型错误或挂起，也不影响
    // 任务结果（finalText/steps）正常返回，UI 不会卡在「处理中」。这是稳健性改进，
    // 与审批上行无关（审批闭环本身已验证正常）。
    void this.consolidateMemory().catch(() => {});
    return {
      steps: summary.steps,
      finalText: summary.finalText,
      usageTokens: summary.usageTokens,
      // 步数耗尽 ⇒ 被截断（未自然收敛）：调用方（子代理 / 工作流步骤）据此避免把
      // 「跑满预算」当成「做完了」（2026-09-26 审计 F10）。
      truncated: summary.steps >= this.maxSteps,
      aborted: summary.aborted,
      // G3-V2：验证状态如实上抛（`unverified` 不得被上层读成"验证通过"）。
      verificationState: summary.verificationState,
    };
  }

  /**
   * 取完成闸门的核验结果（含「何时才该问」的前置条件）。
   *
   * `turn-end` 型闸门会在**回合末尾现跑一次验证命令**，因此必须限定「本回合确实改过文件」——
   * 否则纯问答回合也会平白跑一次测试。`status` 型只是读已有结论（零开销），任何时机都可问。
   * @param sessionId 会话 id。
   * @returns 失败摘要；不应问、或验证通过/无法验证时为 undefined。
   */
  private async completionDigest(sessionId: string): Promise<string | undefined> {
    const gate = this.completionGate;
    if (gate === undefined) {
      return undefined;
    }
    if (gate.kind === 'turn-end' && (this.turnDiff?.changedCount ?? 0) === 0) {
      return undefined;
    }
    return await gate.verify(sessionId);
  }

  /**
   * V2 失控检测观测：true = 熔断（应退出循环）。   * nudge 决策把纠偏文本作为 user 消息注入（模型下一轮看到引导，换方法继续）。
   */
  private observeLoopGuard(): boolean {
    if (this.loopGuard === undefined) {
      return false;
    }
    const decision: LoopDecision = this.loopGuard.observe({
      toolCalls: this.stepRunner.toolCallsOfLastStep,
    });
    if (decision.kind === 'allow') {
      return false;
    }
    if (decision.kind === 'nudge') {
      log.warn('turn.loopguard.nudge', { violation: decision.violation });
      this.recorder.user(decision.message);
      return false;
    }
    log.warn('turn.loopguard.abort', { violation: decision.violation });
    return true;
  }

  /** 回合收尾：有差异则广播 turn_diff 事件，随后重置追踪器（每回合独立计数）。
   * @returns 无返回值。
   */
  private emitTurnDiff(): void {
    if (this.turnDiff === undefined) {
      return;
    }
    const diff = this.turnDiff.getUnifiedDiff();
    if (diff !== undefined) {
      this.recorder.turnDiff(diff);
    }
    this.turnDiff.reset();
  }

  /** 回合末自动沉淀（#S28）：把自上次蒸馏以来的事件蒸馏为跨会话持久事实。
   * @returns 无返回值。
   */
  private async consolidateMemory(): Promise<void> {
    if (this.extractor === undefined || this.longTerm === undefined) {
      return;
    }
    const events = this.recorder.allEvents();
    if (events.length === 0) {
      return;
    }
    try {
      await this.extractor.consolidate(events, this.recorder.sessionId());
    } catch {
      // 蒸馏失败（模型错误/解析失败）不致命：手动 remember 仍可用，跳过本回合自动沉淀。
    }
  }
  /**
   * 回滚后重新对齐压缩游标（透传给 {@link StepRunner.rewindCompactionState}；
   * 语义与必要性见 {@link StepContextBuilder.rewindCompactionState}）。
   * @returns 无返回值。
   */
  public rewindCompactionState(): void {
    this.stepRunner.rewindCompactionState();
  }
}
