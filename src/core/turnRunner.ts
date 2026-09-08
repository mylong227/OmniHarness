import type { ToolContext } from '../ports/tool.js';
import type { StepRunner } from './stepRunner.js';
import type { SessionRecorder } from './sessionRecorder.js';
import type { TurnDiffTracker } from './turnDiffTracker.js';
import type { LongTermMemoryPort } from '../ports/longTermMemory.js';
import type { MemoryExtractor } from '../adapters/memory/memoryExtractor.js';
import { log } from '../util/logger.js';

/** 回合运行结果。 */
export interface TurnOutcome {
  readonly steps: number;
  readonly finalText?: string;
}

/** 回合执行器：0..n 步，直到模型输出文本或步数耗尽。 */
export class TurnRunner {
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
  ) {}

  /** 运行一个回合。 */
  async run(context: ToolContext): Promise<TurnOutcome> {
    log.debug('turn.start', { maxSteps: this.maxSteps });
    let steps = 0;
    while (steps < this.maxSteps) {
      const outcome = await this.stepRunner.run(context);
      steps += 1;
      if (outcome !== 'tool') {
        break;
      }
    }
    // #OBS-9：步数耗尽且全程未产出文本（模型一直在调工具）时，做一次「无工具」
    // 兜底调用强制总结。否则 finalText 为 undefined，用户侧就是「转了很久没有结果」。
    // 仅在真的跑满 maxSteps 时触发——正常结束（模型已输出文本）不会多花这一次调用。
    let finalText = this.recorder.lastAssistantText();
    if (
      (finalText === undefined || finalText.trim() === '') &&
      steps >= this.maxSteps &&
      typeof this.stepRunner.finalize === 'function'
    ) {
      const summary = await this.stepRunner.finalize();
      if (summary !== undefined && summary.trim() !== '') {
        finalText = summary;
      }
    }
    log.info('turn.end', { steps, hasText: finalText !== undefined });
    this.emitTurnDiff();
    // 记忆蒸馏是 best-effort 后台任务（失败不致命，见 consolidateMemory 内部 try/catch）。
    // 异步化：不阻塞 turns.run 的 HTTP 响应——即便蒸馏因模型错误或挂起，也不影响
    // 任务结果（finalText/steps）正常返回，UI 不会卡在「处理中」。这是稳健性改进，
    // 与审批上行无关（审批闭环本身已验证正常）。
    void this.consolidateMemory().catch(() => {});
    return { steps, finalText };
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
