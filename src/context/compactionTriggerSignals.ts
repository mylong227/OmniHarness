import type { ModelMessage } from '../ports/model/modelMessage.ts';

/**
 * 压缩**触发信号**（U2-1，2026-10-30）：把「该不该压缩」从单一预算比拆成四个可观测信号。
 *
 * ## 为什么
 *
 * 现行触发器是「估算 token ≥ 0.8×窗口」一个标量。它对「为什么此刻压」完全失明：
 * 同样的 token 量，可能是 40 轮工具结果堆积（该压），也可能是一段 12k 的长文（未必该压）。
 * CORE_CAPABILITY_UPGRADE §5-U2 要求触发信号组合化：
 * **预算 + 轮数 + 工具结果占比 + 重复率**。但按 D6 纪律，任何「组合规则更好」的结论
 * 都必须有对照数据；在数据出现之前，组合规则**不得接管默认行为**。
 *
 * ## shadow 语义（本类的交付边界）
 *
 * 本类只**计算与上报**，不改变压缩时机——默认决策仍是既有阈值。组合规则给出的是
 * `combinedWouldTrigger`（参考实现，阈值是登记的参考值，非校准结论）；
 * 每步压缩判定时把「现行决策」与「组合规则会怎么说」一并落日志，两者**分歧**时升为 info
 * （对照数据的落点），一致时 debug。等分歧数据足够、过两关后再翻默认。
 */
export class CompactionTriggerSignals {
  /** 组合规则的参考阈值（显式登记，等对照数据校准；不是已验证结论）。 */
  public static readonly REFERENCE = {
    /** 预算占比：≥0.8 与现行阈值一致（主信号）。 */
    budgetRatio: 0.8,
    /** 预算占比在 [0.65, 0.8) 时，工具结果占比 ≥0.5 ⇒ 提前压（工具结果最值得折叠）。 */
    budgetRatioWithToolShare: 0.65,
    toolResultShare: 0.5,
    /** 重复率 ≥0.5 且轮数 ≥12：大量重复工具调用 ⇒ 长会话已在空转，值得折叠。 */
    repetitionRate: 0.5,
    minTurns: 12,
  };

  /**
   * 计算四类信号（确定性，单次遍历，O(消息数)）。
   * @param messages 当前请求消息。
   * @param estimated 当前估算 token（调用方已算好，避免重复估算）。
   * @param budget 生效预算（阈值口径，调用方一致）。
   * @returns 四类信号与组合规则的参考判定。
   */
  public static measure(
    messages: readonly ModelMessage[],
    estimated: number,
    budget: number,
  ): CompactionTriggerSignalsResult {
    let totalChars = 0;
    let toolChars = 0;
    let turns = 0;
    const callTargets = new Map<string, number>();
    let callCount = 0;
    for (const message of messages) {
      const content = message.content ?? '';
      const size = content.length;
      totalChars += size;
      if (message.role === 'user') turns += 1;
      if (message.role === 'tool') toolChars += size;
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        for (const call of message.toolCalls) {
          callCount += 1;
          const target = CompactionTriggerSignals.targetOf(call.arguments);
          const key = `${call.name}\u0000${target}`;
          callTargets.set(key, (callTargets.get(key) ?? 0) + 1);
        }
      }
    }
    let repeatedCalls = 0;
    for (const count of callTargets.values()) {
      if (count > 1) repeatedCalls += count;
    }
    const budgetRatio = budget > 0 ? estimated / budget : 0;
    const toolResultShare = totalChars > 0 ? toolChars / totalChars : 0;
    const repetitionRate = callCount > 0 ? repeatedCalls / callCount : 0;
    const combinedWouldTrigger = CompactionTriggerSignals.combinedDecision({
      budgetRatio,
      turns,
      toolResultShare,
      repetitionRate,
    });
    return {
      budgetRatio: CompactionTriggerSignals.round(budgetRatio),
      turns,
      toolResultShare: CompactionTriggerSignals.round(toolResultShare),
      repetitionRate: CompactionTriggerSignals.round(repetitionRate),
      combinedWouldTrigger,
    };
  }

  /**
   * 组合规则的**参考**判定（阈值见 {@link CompactionTriggerSignals.REFERENCE}，未经两关校准）。
   * @param s 四类信号。
   * @returns 组合规则是否会触发。
   */
  private static combinedDecision(s: {
    budgetRatio: number;
    turns: number;
    toolResultShare: number;
    repetitionRate: number;
  }): boolean {
    const r = CompactionTriggerSignals.REFERENCE;
    return (
      s.budgetRatio >= r.budgetRatio ||
      (s.budgetRatio >= r.budgetRatioWithToolShare && s.toolResultShare >= r.toolResultShare) ||
      (s.repetitionRate >= r.repetitionRate && s.turns >= r.minTurns)
    );
  }

  /** 工具调用参数的目标（命令/路径/模式/URL，单行截断）——与台账同一口径的重复键。
   * @param args 工具参数对象。
   * @returns 单行截断后的目标串（无可用字段为空串）。
   */
  private static targetOf(args: Record<string, unknown>): string {
    const raw = args['command'] ?? args['path'] ?? args['pattern'] ?? args['url'] ?? args['query'];
    if (typeof raw !== 'string') return '';
    const oneLine = raw.replace(/\s+/gu, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }

  /** 信号保留 3 位小数（日志可读，比较不受影响）。
   * @param value 原始比值。
   * @returns 保留 3 位小数的比值。
   */
  private static round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }
}

/** 四类触发信号与组合规则的参考判定。 */
export interface CompactionTriggerSignalsResult {
  /** 估算 token / 生效预算（现行阈值即 ≥0.8）。 */
  readonly budgetRatio: number;
  /** user 消息条数（会话轮数下界）。 */
  readonly turns: number;
  /** tool 消息字符数 / 全部消息字符数。 */
  readonly toolResultShare: number;
  /** 重复（工具+目标）调用数 / 总调用数。 */
  readonly repetitionRate: number;
  /** 组合规则（参考实现）是否建议触发——shadow，不改变实际决策。 */
  readonly combinedWouldTrigger: boolean;
}
