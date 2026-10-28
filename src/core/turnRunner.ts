import type { ToolContext } from '../ports/tool/tool.ts';
import type { CompletionGate, VerificationState } from '../ports/runtime/completionGate.ts';
import type { CheckpointManagerPort } from '../ports/runtime/checkpointManager.ts';
import type { ReviewPort } from '../ports/tool/review.ts';
import { BudgetExceededError } from '../ports/model/model.ts';
import type { StepRunner, StepOutcome } from './stepRunner.ts';
import type { SessionRecorder } from './sessionRecorder.ts';
import type { TurnDiffTrackerPort } from '../ports/runtime/turnDiffTracker.ts';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.ts';
import type { MemoryExtractorPort } from '../ports/memory/memoryExtractor.ts';
import type { WorkflowMemoryPort } from '../ports/memory/workflowMemory.ts';
import type { TodoPort } from '../ports/runtime/todo.ts';
import { WorkflowMemoryRecorder } from './workflowMemoryRecorder.ts';
import { LoopGuard, type LoopDecision } from './loop/loopGuard.ts';
import { EvidenceLedger } from './evidenceLedger.ts';
import type { EventPersister } from './loop/eventPersister.ts';
import { log } from '../util/logger.ts';

// 完成闸门契约已下沉到 `ports/runtime/completionGate.ts`（2026-09-27，修架构违规：契约留在 core
// 会逼适配器 import core）。此处原路径**继续导出**，保持既有公共 API 面不变。
export type { CompletionGate } from '../ports/runtime/completionGate.ts';

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
  /** 独立审查是否已用过（VER-06，有界：每回合至多一次）。 */
  reviewed: boolean;
  /** 本回合的验证状态（G3-V2）；`unverified` 不得读成通过。 */
  verificationState: VerificationState;
}

/**
 * 连续空响应（模型既无文本也无工具调用）的重试上限。 * 设有限值：空响应重试是有界的，避免整份步数预算被空转烧光；
 * 达上限即退出并由兜底总结收尾。
 */
const MAX_CONSECUTIVE_EMPTY = 3;

/** 回合执行器：0..n 步，直到模型输出文本（任务完成）；`maxSteps > 0` 时才额外受步数上限约束。 */
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
     * 交由兜底总结收尾——token 预算终止，比纯步数更贴近真实成本。
     */
    private readonly tokenBudget = 0,
    /**
     * 回合完成闸门（A1，可选）：模型声明「做完了」时核验本会话最近一次自验证结果；
     * 仍有失败则回灌并再给一步（**每回合至多一次**）。缺省 undefined＝不设闸门（旧行为）。
     */
    private readonly completionGate?: CompletionGate,
    /** Workflow Memory（P4，可选）：成功回合自动沉淀、下一回合按任务召回参考。 */
    workflowMemory?: WorkflowMemoryPort | undefined,
    /**
     * 自动检查点（LR-06，可选）：每 20 步落一次事件检查点。无文件快照，文件面仍由
     * `checkpoint` 工具显式负责；失败只告警，绝不阻断主流程。
     */
    private readonly autoCheckpoints?: CheckpointManagerPort | undefined,
    /**
     * 独立审查端口（VER-06，可选）：完成声明时对 `turnDiff.getUnifiedDiff()` 跑一次
     * 干净上下文审查；`reviewBlock` 决定 blocker/major 是回灌阻断（true）还是 advisory（false）。
     */
    private readonly reviewer?: ReviewPort | undefined,
    /** 是否把 reviewer 的 blocker/major 当阻断（默认 false = advisory，避免误杀）。 */
    private readonly reviewBlock = false,
    /**
     * 待办端口（可选）：模型宣告完成时若仍有 pending/in_progress，注入一次纠偏。
     *
     * 为什么放在 TurnRunner 而不是提示词：提示词只能"建议"；实测模型仍会在待办未完成时
     * 直接收尾。这里用一次有界的状态检查兜住「提前宣告完成」，比无限要求模型自省可靠。
     */
    private readonly todo?: TodoPort | undefined,
    /**
     * 软 token 预算（2026-10-23，可选，0 = 关闭）：达到该值时注入一次「开始收尾」提醒，
     * 但**不停止**步进；硬预算仍由 {@link tokenBudget} 在 100% 时熔断。
     *
     * 与硬预算分开的理由：默认不设硬上限（长任务可能确实需要更多 token），但完全没有任何
     * 提醒时，一个「一直在做新事情」的回合可以跑到 8h 硬时限。软预算只提醒、不截断。
     */
    private readonly softTokenBudget = 0,
    /**
     * 回合中 steering 队列（A8，可选）：每步结束后、下一步开始前取一条用户追加指令。
     * 只在步边界消费，保证不会插进 `assistant(tool_calls) ↔ tool` 中间。
     */
    private readonly steering?: (() => string | undefined) | undefined,
  ) {
    this.loopGuard = loopGuard;
    this.workflowRecorder =
      workflowMemory === undefined ? undefined : new WorkflowMemoryRecorder(workflowMemory);
  }

  /** Workflow Memory 自动沉淀/召回器（未注入为 undefined）。 */
  private readonly workflowRecorder: WorkflowMemoryRecorder | undefined;

  /** 运行一个回合。 */

  public async run(context: ToolContext): Promise<TurnOutcome> {
    log.debug('turn.start', { maxSteps: this.maxSteps });
    const workflow = await this.prepareWorkflow();
    // 标记回合起点：finalText 只认本回合产出的 assistant，避免 resume 时串到历史答案（#OBS-10）。
    this.recorder.markTurnStart();
    let steps = 0;
    let consecutiveEmpty = 0;
    let aborted = false;
    /** 是否**由模型产出结论**而结束（自然收敛）；`truncated` 取它的反。 */
    let converged = false;
    let usageTokens = 0;
    /** 待办纠偏是否已用过（每回合至多一次，避免把收尾卡死）。 */
    let todoReminded = false;
    /** 软 token 预算提醒是否已用过（每回合至多一次）。 */
    let softBudgetNudged = false;
    /** 本回合的完成判定状态（就地更新；用对象承载以便抽方法传引用）。 */
    const claim: CompletionClaim = { gated: false, reviewed: false, verificationState: 'not-run' };
    // 不限步数（0/undefined/负数都按不限处理）：终止由「模型产出结论 / 预算 / 行为护栏 / 取消」决定。
    while (!(this.maxSteps > 0) || steps < this.maxSteps) {
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
      await this.maybeAutoCheckpoint(steps, context.sessionId);
      // V2.1 token 预算累计（B4）：usage 缺失的模型不计入（绝不臆造）。
      const stepUsage = this.stepRunner.usageOfLastStep;
      if (stepUsage !== undefined) {
        usageTokens += stepUsage.totalTokens;
      }
      // V2 增量持久化：每步安排 write-behind 落盘（崩溃最多丢一个批量窗口）。
      this.persister?.schedule();
      // 软预算只提醒、硬预算才停止：两步都集中在一个方法里，避免 run() 继续膨胀。
      const budget = this.applyTokenBudgets(usageTokens, steps, softBudgetNudged);
      softBudgetNudged = budget.softNudged;
      if (budget.stop) break;
      if (this.consumeSteering()) continue;
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
        const action = await this.afterText(claim, context.sessionId, steps, todoReminded);
        if (action !== 'done') {
          todoReminded ||= action === 'nudge';
          continue;
        }
        converged = true;
        break;
      } // 'empty'：模型既没给文本也没调工具（空响应/被安全过滤/上游截断）。
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
    const finalText = await this.finalTextOf();
    const outcome = await this.closeTurn({
      steps,
      usageTokens,
      aborted,
      // 未自然收敛（预算/失控/空转/步数上限任一）都要如实上报"没做完"。
      truncated: !converged,
      finalText,
      verificationState: claim.verificationState,
    });
    await this.captureWorkflow(workflow.task, workflow.start, outcome);
    return outcome;
  }

  /**
   * 步边界消费一条 steering（A8）。
   * @returns 是否注入了一条 user 消息（true ⇒ 下一步继续）。
   */
  private consumeSteering(): boolean {
    const text = this.steering?.();
    if (text === undefined || text === '') return false;
    this.recorder.user(text);
    return true;
  }

  /**
   * 回合开始：按任务召回 workflow 并记事件起点（P4）；未注入即零行为。
   * @returns 任务文本与事件起点
   */
  private async prepareWorkflow(): Promise<{ task?: string; start: number }> {
    const task = WorkflowMemoryRecorder.taskOf(this.recorder.allEvents());
    const priming = await this.workflowRecorder?.prime(task);
    if (priming !== undefined) {
      this.recorder.system(priming);
    }
    return { ...(task === undefined ? {} : { task }), start: this.recorder.allEvents().length };
  }

  /**
   * 成功回合自动沉淀 workflow（P4）；失败/截断/未验证即不记，写失败 fail-open。
   * @param task 本回合任务
   * @param start 本回合事件起点
   * @param outcome 回合结果
   * @returns 无返回值
   */
  private async captureWorkflow(
    task: string | undefined,
    start: number,
    outcome: TurnOutcome,
  ): Promise<void> {
    const success =
      !outcome.truncated && outcome.aborted !== true && outcome.verificationState !== 'unverified';
    await this.workflowRecorder?.capture(task, this.recorder.allEvents().slice(start), success);
  }

  /**
   * 读取本会话未完成的待办（pending/in_progress）。
   * @param sessionId 会话标识。
   * @returns 未完成项；未注入待办端口或无会话桶时为空。
   */
  private openTodos(sessionId: string): readonly { readonly content: string }[] {
    if (this.todo === undefined) {
      return [];
    }
    return this.todo
      .list(sessionId)
      .filter((item) => item.status === 'pending' || item.status === 'in_progress')
      .map((item) => ({ content: item.content }));
  }

  /**
   * 应用软/硬 token 预算：软预算只写一次收尾提醒，硬预算返回 `stop=true`。
   * @param usageTokens 本回合累计 token。
   * @param steps 当前步数。
   * @param softNudged 软预算是否已提醒过。
   * @returns 是否停止步进 + 更新后的软提醒标记。
   */
  private applyTokenBudgets(
    usageTokens: number,
    steps: number,
    softNudged: boolean,
  ): { readonly stop: boolean; readonly softNudged: boolean } {
    let nudged = softNudged;
    if (this.softTokenBudget > 0 && !nudged && usageTokens >= this.softTokenBudget) {
      nudged = true;
      log.warn('turn.soft_token_budget_nudge', {
        steps,
        usageTokens,
        softBudget: this.softTokenBudget,
      });
      this.recorder.system(
        `【预算提醒】本回合 token 用量（${usageTokens}）已达软预算（${this.softTokenBudget}）。` +
          '请开始收尾：优先完成当前验证并总结，不要开启新的探索方向；' +
          '若任务确实未完成，请在总结中明确剩余项与阻塞点。',
      );
    }
    if (this.tokenBudget > 0 && usageTokens >= this.tokenBudget) {
      log.warn('turn.token_budget_reached', { steps, usageTokens, budget: this.tokenBudget });
      this.recorder.system(
        `【预算】本回合 token 用量（${usageTokens}）已达预算上限（${this.tokenBudget}），停止步进。`,
      );
      return { stop: true, softNudged: nudged };
    }
    return { stop: false, softNudged: nudged };
  }

  /**
   * 取本回合的最终文本（从 `run` 外移：铁律函数体上限，且这段是自洽的一件事）。
   *
   * 口径：优先取模型本轮产出的最后一条 assistant 文本；**一条都没有**时（模型一直在调工具、
   * 连续空响应、或失控熔断）做一次**无工具**的兜底调用（`StepRunner.finalize`），
   * 强制它把"已完成但未落盘"的改动与结论交接出来——否则用户侧就是"转了很久没有结果"。
   * @returns 最终文本；兜底也没产出时为 undefined。
   */
  private async finalTextOf(): Promise<string | undefined> {
    const existing = this.recorder.lastAssistantText();
    if (existing !== undefined && existing.trim() !== '') return existing;
    if (typeof this.stepRunner.finalize !== 'function') return existing;
    const summary = await this.stepRunner.finalize();
    return summary !== undefined && summary.trim() !== '' ? summary : existing;
  }
  /**
   * 每 20 步自动落一次事件检查点（LR-06）。失败只告警——检查点是增强，不是主流程闸门。
   * @param steps 当前步数。
   * @param sessionId 会话 id。
   * @returns 无返回值。
   */
  private async maybeAutoCheckpoint(steps: number, sessionId: string): Promise<void> {
    if (this.autoCheckpoints === undefined || steps % 20 !== 0) return;
    try {
      await this.autoCheckpoints.snapshot(sessionId, `auto-${String(steps)}`);
    } catch (error) {
      log.warn('turn.autocheckpoint.failed', {
        steps,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 文本步后的收尾判定：完成闸门优先，其次检查未完成待办。
   * @param claim 完成判定状态（就地更新）。
   * @param sessionId 会话 id。
   * @param steps 当前步数。
   * @param todoReminded 待办纠偏是否已用过。
   * @returns `retry` 继续改；`nudge` 已注入待办纠偏、继续执行；`done` 允许收尾。
   */
  private async afterText(
    claim: CompletionClaim,
    sessionId: string,
    steps: number,
    todoReminded: boolean,
  ): Promise<'retry' | 'nudge' | 'done'> {
    if ((await this.handleCompletionClaim(claim, sessionId, steps)) === 'retry') {
      return 'retry';
    }
    if (todoReminded) {
      return 'done';
    }
    const open = this.openTodos(sessionId);
    if (open.length === 0) {
      return 'done';
    }
    this.recorder.system(
      '【待办未完成】以下待办仍是 pending/in_progress：' +
        open.map((item) => `- ${item.content}`).join('；') +
        '。请继续执行并更新 `todo_write`；若确实无法完成，明确说明阻塞点，不要宣告完成。',
    );
    return 'nudge';
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
    // VER-02：证据账本下限——有工具调用但全部失败时，不允许“通过”完成。
    if (
      !claim.gated &&
      !EvidenceLedger.hasCompletionEvidence(this.recorder.eventsSinceTurnStart())
    ) {
      claim.verificationState = 'unverified';
      log.warn('turn.evidence.missing', { steps, sessionId });
    }
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
    // VER-06（2026-10-21）：reviewer 存在即跑一次；`reviewBlock` 只决定阻断还是 advisory。
    if (!claim.gated && !claim.reviewed && this.reviewer !== undefined) {
      claim.reviewed = true;
      const review = await this.reviewDigest();
      if (review !== undefined && review !== '') {
        if (this.reviewBlock) {
          claim.verificationState = 'failed';
          log.warn('turn.review.blocked', { steps, sessionId });
          this.recorder.user(
            '【独立审查】你已声明完成，但干净上下文 reviewer 报出 blocker/major 问题：\n' +
              `${review}\n` +
              '请先修好它再收尾；若你判断其中某条不成立，请在结论里逐条给出反证（文件/行/测试）。',
          );
          return 'retry';
        }
        // advisory：不阻断、不改变验证状态，但必须留痕——否则「审查跑过没跑过、报了什么」
        // 在会话里完全不可见，等于隐式关闭。
        log.warn('turn.review.advisory', { steps, sessionId });
        this.recorder.system(
          '【独立审查/advisory】完成声明时 reviewer 报出 blocker/major（未阻断，仅提示）：\n' +
            review,
        );
      }
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
   * 对当前回合 diff 跑一次独立审查（VER-06）。
   *
   * 只把 `diff + 任务目标` 交给 reviewer，不传父会话历史；reviewer 异常按 advisory 处理
   * （返回 undefined，不让审查基建故障阻断正常收尾）。
   * @returns 阻断级问题摘要；无 diff / 无阻断 / 审查失败时为 undefined。
   */
  private async reviewDigest(): Promise<string | undefined> {
    if (this.reviewer === undefined) return undefined;
    const diff = this.turnDiff?.getUnifiedDiff();
    if (diff === undefined || diff.trim() === '') return undefined;
    try {
      const report = await this.reviewer.review({
        diff,
        goal: this.recorder.lastUserText() ?? '完成当前任务',
      });
      const blocking = report.findings.filter(
        (finding) => finding.severity === 'blocker' || finding.severity === 'major',
      );
      if (!report.ok || blocking.length === 0) return undefined;
      return blocking
        .map(
          (finding) =>
            `- [${finding.severity}] ${finding.file}${
              finding.line === undefined ? '' : `:${String(finding.line)}`
            } — ${finding.issue}\n  证据：${finding.evidence}`,
        )
        .join('\n');
    } catch (error) {
      log.warn('turn.review.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 回合收尾（观测 → 落盘 flush → diff 广播 → 记忆蒸馏 → 组装结果）。
   *
   * 抽出的动因有两层：① `run` 已达函数体上限；② 收尾语义（含「是否被截断」的判定）集中一处，
   * 避免以后再加退出路径时漏带状态。
   * @param summary 本回合的收尾事实（步数 / token 用量 / 是否熔断 / 是否未自然收敛 / 最终文本）。
   * @returns 回合结果（`truncated` = 未自然收敛：预算熔断 / 失控熔断 / 空转止损 / 显式步数上限任一）。
   */
  private async closeTurn(summary: {
    readonly steps: number;
    readonly usageTokens: number;
    readonly aborted: boolean;
    /** 是否未自然收敛（预算/失控/空转/步数上限任一）——见调用点与返回值处的口径注释。 */
    readonly truncated: boolean;
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
    // 兜底 catch 也留轨迹（2026-10-27 审计收口）：蒸馏链路长期无声失败
    // （extractor 配置错/模型持续 4xx）用户无从发现。
    void this.consolidateMemory().catch((error: unknown) => {
      log.warn('memory.consolidate.unhandled', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return {
      steps: summary.steps,
      finalText: summary.finalText,
      usageTokens: summary.usageTokens,
      // 「未自然收敛」= 本回合不是由模型产出结论而结束的：显式步数上限、token/成本预算熔断、
      // LoopGuard 失控熔断、连续空转止损都算。调用方（子代理 / 工作流步骤）据此避免把
      // 「跑满预算」当成「做完了」（2026-09-26 审计 F10；2026-10-15 去掉步数上限后，
      // 这条判断不能再只看步数——否则被预算掐断的回合会被读成完成）。
      truncated: summary.truncated,
      aborted: summary.aborted,
      // G3-V2：验证状态如实上抛（`unverified` 不得被上层读成"验证通过"）。
      verificationState: summary.verificationState,
    };
  }

  /**
   * 取完成闸门的核验结果（含「何时才该问」的前置条件）。
   *
   * `turn-end` 型闸门会在**回合末尾现跑一次验证命令**，因此必须限定「本回合可能改过文件」——
   * 否则纯问答回合也会平白跑一次测试。判定用**两个**信号（2026-10-28 修）：
   *  - `changedCount > 0`：有可精确记账的写入；
   *  - `isValid === false`：出现过无法逐文件归因的写（shell 重定向/脚本/依赖安装…），
   *    `invalidate()` 会把 `changedCount` 清成 0——只看计数等于「shell 改过文件也跳过验证」。
   * `status` 型只是读已有结论（零开销），任何时机都可问。
   * @param sessionId 会话 id。
   * @returns 失败摘要；不应问、或验证通过/无法验证时为 undefined。
   */
  private async completionDigest(sessionId: string): Promise<string | undefined> {
    const gate = this.completionGate;
    if (gate === undefined) {
      return undefined;
    }
    const tracked = this.turnDiff;
    const mayHaveChanged =
      (tracked?.changedCount ?? 0) > 0 || (tracked !== undefined && tracked.isValid === false);
    if (gate.kind === 'turn-end' && !mayHaveChanged) {
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
      // 结果维度：同一份内容被反复取回（长会话主病）只能靠结果指纹发现。
      results: this.stepRunner.toolResultsOfLastStep,
    });
    if (decision.kind === 'allow') {
      return false;
    }
    if (decision.kind === 'nudge') {
      log.warn('turn.loopguard.nudge', { violation: decision.violation });
      // synthetic=true：模型要看到 nudge，但工具暴露 / repo-map 的「任务文本」推导必须跳过它。
      this.recorder.user(decision.message, undefined, undefined, true);
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
    } catch (error) {
      // 蒸馏失败（模型错误/解析失败）不致命：手动 remember 仍可用，跳过本回合自动沉淀。
      // 但必须可观测（2026-10-27 审计收口）：否则「记忆在沉淀」是假象，配置错/持续 4xx
      // 会长期无声失败。
      log.warn('memory.consolidate.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
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
