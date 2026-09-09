import type { ToolContext } from '../ports/tool.js';
import type { StepRunner } from './stepRunner.js';
import type { SessionRecorder } from './sessionRecorder.js';
import type { TurnDiffTracker } from './turnDiffTracker.js';
import type { LongTermMemoryPort } from '../ports/longTermMemory.js';
import type { MemoryExtractor } from '../adapters/memory/memoryExtractor.js';
import { LoopGuard, type LoopDecision } from './loop/loopGuard.js';
import type { EventPersister } from './loop/eventPersister.js';
import { log } from '../util/logger.js';

/** 回合运行结果。 */
export interface TurnOutcome {
  readonly steps: number;
  readonly finalText?: string;
}

/**
 * 连续空响应（模型既无文本也无工具调用）的重试上限。
 * 设有限值：空响应重试是有界的，避免整份步数预算被空转烧光；
 * 达上限即退出并由兜底总结收尾。
 */
const MAX_CONSECUTIVE_EMPTY = 3;

/** 回合执行器：0..n 步，直到模型输出文本或步数耗尽。 */
export class TurnRunner {
  private readonly loopGuard: LoopGuard | undefined;

  constructor(
    private readonly stepRunner: StepRunner,
    private readonly recorder: SessionRecorder,
    private readonly maxSteps: number,
    /** 回合级变更追踪器（#M5，可选）：回合结束时产出 unified diff 并广播。 */
    private readonly turnDiff?: TurnDiffTracker,
    /** 长期记忆端口（#S28，可选）：回合末蒸馏沉淀的目的地。 */
    private readonly longTerm?: LongTermMemoryPort,
    /** 长期记忆蒸馏器（#S28，可选）：回合末把自上次以来的事件蒸馏为持久事实。 */
    private readonly extractor?: MemoryExtractor,
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
  ) {
    this.loopGuard = loopGuard;
  }

  /** 运行一个回合。 */
  async run(context: ToolContext): Promise<TurnOutcome> {
    log.debug('turn.start', { maxSteps: this.maxSteps });
    // 标记回合起点：finalText 只认本回合产出的 assistant，避免 resume 时串到历史答案（#OBS-10）。
    this.recorder.markTurnStart();
    let steps = 0;
    let consecutiveEmpty = 0;
    let aborted = false;
    while (steps < this.maxSteps) {
      const outcome = await this.stepRunner.run(context);
      steps += 1;
      // V2 增量持久化：每步安排 write-behind 落盘（崩溃最多丢一个批量窗口）。
      this.persister?.schedule();
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
    log.info('turn.end', {
      steps,
      hasText: finalText !== undefined,
      aborted,
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
    return { steps, finalText };
  }

  /**
   * V2 失控检测观测：true = 熔断（应退出循环）。
   * nudge 决策把纠偏文本作为 user 消息注入（模型下一轮看到引导，换方法继续）。
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

  /** 回合收尾：有差异则广播 turn_diff 事件，随后重置追踪器（每回合独立计数）。 */
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

  /** 回合末自动沉淀（#S28）：把自上次蒸馏以来的事件蒸馏为跨会话持久事实。 */
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
}
