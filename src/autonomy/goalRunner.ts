import type { AgentPort, AgentResult } from '../ports/runtime/agent.js';
import { GoalChecker } from './goalChecker.js';
import { CANCELLED_BY_PARENT_MESSAGE } from '../subagent/subagentTypes.js';

/**
 * @beta
 * 自主目标循环默认最大迭代次数。
 */
export const DEFAULT_GOAL_MAX_ITERATIONS = 10;

/**
 * @beta
 * 自主目标循环选项。
 */
export interface GoalRunnerOptions {
  /** 最大迭代次数（默认 10）；每轮 = 一次回合推进 + 一次达成度判定。 */
  readonly maxIterations?: number | undefined;
  /**
   * 父会话取消信号（可选）：置位后不再开启下一轮迭代（当前轮的在飞模型请求由
   * 子代 runtime 的取消感知模型端口中止）。缺省 undefined＝不传播取消。
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * @beta
 * 自主目标循环结果。
 */
export interface GoalResult {
  /** 原始目标。 */
  readonly goal: string;
  /** 是否在预算内达成。 */
  readonly achieved: boolean;
  /** 实际执行的迭代次数。 */
  readonly iterations: number;
  /** 主会话 ID（跨迭代复用同一会话，模型拥有完整上下文）。 */
  readonly sessionId: string;
  /** 末轮模型产出文本。 */
  readonly finalText?: string | undefined;
  /** 终止原因（达成 / 达迭代上限 / 异常）。 */
  readonly reason: string;
}

/**
 * @beta
 * 自主目标循环（对标 dsh goal / ralph）：在无人逐步干预下朝目标反复推进，
 * 每轮跑一次回合、用 {@link GoalChecker} 判达成度，达成即停、否则续跑，
 * 直到达成或触及 {@link GoalRunnerOptions.maxIterations} 上限。
 *
 * 复用 {@link Agent} 主循环意味着自动继承上下文压缩、工具结果外溢、FFI 原生后端等全部既有能力，
 * 不另写一套——与 #76 子智能体同一思路，本类只负责「迭代驱动 + 达成判定」。
 */
export class GoalRunner {
  private readonly maxIterations: number;
  /** 父会话取消信号（缺省 undefined＝不传播取消）。 */
  private readonly signal: AbortSignal | undefined;

  public constructor(
    private readonly agent: AgentPort,
    private readonly checker: GoalChecker,
    options: GoalRunnerOptions = {},
  ) {
    this.maxIterations = options.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS;
    this.signal = options.signal;
  }

  /**
   * 运行自主目标循环直到达成、达上限或父会话取消。
   * @param goal 目标描述
   * @returns 最终轮结果（达成与否、轮次、会话 id、结论）
   */
  public async run(goal: string): Promise<GoalResult> {
    const first = await this.agent.runTask(this.promptFor(goal, 1));
    // 取消后不再跑达成度判定（判定本身要花一次模型调用，省下它）。
    if (this.isCancelled()) {
      return this.cancelled(goal, first);
    }
    const achievedFirst = await this.check(first, goal, 1);
    if (achievedFirst.achieved) {
      return achievedFirst;
    }
    let last = first;
    for (let i = 2; i <= this.maxIterations; i += 1) {
      // 父会话已取消：不再开启新迭代（每轮都是一次完整回合，提前收手即省下整轮 token）。
      if (this.isCancelled()) {
        return this.cancelled(goal, last);
      }
      last = await this.agent.resume(last.sessionId, this.promptFor(goal, i));
      if (this.isCancelled()) {
        return this.cancelled(goal, last);
      }
      const checked = await this.check(last, goal, i);
      if (checked.achieved) {
        return checked;
      }
    }
    if (this.isCancelled()) {
      return this.cancelled(goal, last);
    }
    return {
      goal,
      achieved: false,
      iterations: this.maxIterations,
      sessionId: last.sessionId,
      finalText: last.finalText,
      reason: `已达最大迭代次数 ${this.maxIterations} 仍未判定达成`,
    };
  }

  /**
   * 父会话是否已取消（未注入取消信号时恒为 false）。
   * @returns 已取消为 true
   */
  private isCancelled(): boolean {
    return this.signal?.aborted === true;
  }

  /**
   * 封装「父取消」终止结果（诚实报告：未达成，原因是取消而非未达标）。
   * @param goal 目标描述
   * @param last 最后一轮 agent 产出
   * @returns 终止原因标记为取消的 GoalResult
   */
  private cancelled(goal: string, last: AgentResult): GoalResult {
    return {
      goal,
      achieved: false,
      iterations: 0,
      sessionId: last.sessionId,
      finalText: last.finalText,
      reason: CANCELLED_BY_PARENT_MESSAGE,
    };
  }

  /**
   * 对一轮结果做达成判定并封装为 GoalResult。
   * @param outcome 本轮 agent 产出
   * @param goal 目标描述
   * @param iteration 当前轮次（从 1 起）
   * @returns 封装后的轮次结果
   */
  private async check(outcome: AgentResult, goal: string, iteration: number): Promise<GoalResult> {
    const check = await this.checker.check(goal, outcome.finalText ?? '');
    return {
      goal,
      achieved: check.achieved,
      iterations: iteration,
      sessionId: outcome.sessionId,
      finalText: outcome.finalText,
      reason: check.achieved ? '目标已达成' : `第 ${iteration} 轮未达成`,
    };
  }

  /**
   * 构造第 n 次迭代的提示词（首轮下达目标，后续轮基于已有进展续推）。
   * @param goal 目标描述
   * @param n 迭代轮次（从 1 起）
   * @returns 本轮提示词
   */
  private promptFor(goal: string, n: number): string {
    if (n === 1) {
      return `目标：${goal}\n\n请开始推进该目标。完成可验证的部分后停下来，汇报本轮进展与结论。`;
    }
    return `目标：${goal}\n\n这是第 ${n} 次迭代，请基于已有进展继续推进，直到目标完全达成。每轮结束汇报进展。`;
  }
}
