import type { ModelMessage } from '../ports/model/model.ts';
import { ToolRoundSanitizer } from '../util/toolRoundSanitizer.ts';
import { log } from '../util/logger.ts';
import type { TokenEstimator } from './tokenEstimator.ts';

/**
 * 压缩结果的预算组装器（2026-10-21 从 `ContextCompactor` 拆出）。
 *
 * 为什么单独成类：压缩器已贴着「文件行数上限」门禁，而 pinned system 段的加入让组装逻辑
 * （摘要 + 最近消息 + 预算兜底）变复杂。把「怎么装、丢哪条」抽出来，压缩器只留「何时压、
 * 摘要什么」；两条路径（首次压缩 / 游标复用）继续共用同一实现，保证结果一致。
 */
export class CompactionComposer {
  /**
   * 组装「pinned system + 摘要 + 最近消息」并保证落入预算。
   *
   * 结构固定为 `[pinned..., summary, ...tail]`：pinned 是常驻指令（world_state / AGENTS.md /
   * 技能），摘要排在它之后，模型先看到不可违反的规则再看到历史摘要。
   * 超预算时只从 tail 的**最旧**一端丢，pinned 与摘要本身永不参与。
   * @param summary 摘要文本。
   * @param tail 最近消息（已收缩并消毒）。
   * @param budget 可用消息预算。
   * @param pinned 前导 system 段（原样保留；缺省为空，兼容旧调用）。
   * @param estimator token 估算器。
   * @returns 预算内的消息数组与丢弃条数。
   */
  public static compose(
    summary: string,
    tail: readonly ModelMessage[],
    budget: number,
    pinned: readonly ModelMessage[],
    estimator: TokenEstimator,
  ): { readonly messages: readonly ModelMessage[]; readonly dropped: number } {
    const prefix: readonly ModelMessage[] = [...pinned, { role: 'system', content: summary }];
    let final: readonly ModelMessage[] = [...prefix, ...tail];
    let dropped = 0;
    while (final.length > prefix.length + 1 && estimator.estimateMessages(final) > budget) {
      const step = CompactionComposer.dropOldestTurn(final.slice(prefix.length));
      if (step.dropped === 0) break;
      final = [...prefix, ...step.body];
      dropped += step.dropped;
    }
    if (estimator.estimateMessages(final) > budget) {
      // 只剩 pinned + 摘要 + 最新一条仍超预算：不再牺牲常驻指令与最新事实，如实留痕。
      log.warn('compaction.compose.over_budget', {
        pinnedMessages: pinned.length,
        messages: final.length,
        budget,
      });
    }
    return { messages: final, dropped };
  }

  /**
   * 预算兜底：从最旧一端逐条丢弃，但**永不动前导 system 段**（系统提示/安全约束），
   * 同时保留最后一条（最新事实），避免预算极紧时把用户刚说的话也丢掉。
   * @param messages 候选消息（按时间顺序）。
   * @param budget 可用消息预算。
   * @param estimator token 估算器。
   * @returns 预算内的消息与实际丢弃条数。
   */
  public static dropOldest(
    messages: readonly ModelMessage[],
    budget: number,
    estimator: TokenEstimator,
  ): { readonly messages: readonly ModelMessage[]; readonly dropped: number } {
    const sanitized = ToolRoundSanitizer.sanitizeToolRounds(messages);
    const prefixCount = CompactionComposer.leadingSystemCount(sanitized);
    const prefix = sanitized.slice(0, prefixCount);
    let body: readonly ModelMessage[] = sanitized.slice(prefixCount);
    let dropped = 0;
    while (body.length > 1 && estimator.estimateMessages([...prefix, ...body]) > budget) {
      const step = CompactionComposer.dropOldestTurn(body);
      if (step.dropped === 0) break;
      body = step.body;
      dropped += step.dropped;
    }
    const current = [...prefix, ...body];
    if (estimator.estimateMessages(current) > budget) {
      log.warn('compaction.drop.over_budget', {
        messages: current.length,
        systemMessages: prefix.length,
      });
    }
    return { messages: current, dropped };
  }

  /**
   * 从最旧一端丢弃**一整个对话轮**（而不是逐条丢）。
   *
   * 逐条丢 + 事后 sanitize 会把一个工具轮从中间切开：实测一次丢掉「user + 整轮工具结果」
   * 4 条，只剩 pinned + 摘要，模型看不到最新指令/结果。按轮丢的边界：
   *  - 从 body[0] 开始，找到**下一个 user 消息**（它就是下一轮起点）；
   *  - 找不到下一个 user（body 全是 assistant/tool）时，只保留最后一条（最新事实）。
   * @param body 已去前导 system 的消息体。
   * @returns 丢弃后的消息体与实际丢弃条数。
   */
  private static dropOldestTurn(body: readonly ModelMessage[]): {
    readonly body: readonly ModelMessage[];
    readonly dropped: number;
  } {
    if (body.length <= 1) {
      return { body, dropped: 0 };
    }
    let end = 1;
    while (end < body.length && body[end]?.role !== 'user') end += 1;
    // 没有下一轮起点：保留最后一条，避免把「最新事实」一起丢光。
    if (end >= body.length) end = body.length - 1;
    const next = ToolRoundSanitizer.sanitizeToolRounds(body.slice(end));
    return { body: next, dropped: body.length - next.length };
  }

  /**
   * 取前导连续 system 消息（原样引用）。
   *
   * 这些消息是 harness 编排的**常驻指令**（world_state / AGENTS.md / 技能注入），
   * 不是可折叠的对话历史；压缩时必须钉在结果头部，否则模型会失去行为约束。
   * @param messages 消息数组。
   * @returns 前导 system 消息（可能为空）。
   */
  public static leadingSystemMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    return messages.slice(0, CompactionComposer.leadingSystemCount(messages));
  }

  /**
   * 前导连续 system 消息的条数。
   * @param messages 消息数组。
   * @returns 条数。
   */
  private static leadingSystemCount(messages: readonly ModelMessage[]): number {
    let count = 0;
    while (messages[count]?.role === 'system') count += 1;
    return count;
  }
}
