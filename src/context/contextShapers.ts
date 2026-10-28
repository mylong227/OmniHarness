import type { ModelMessage } from '../ports/model/model.ts';
import { ToolRoundSanitizer } from '../util/toolRoundSanitizer.ts';

/** 分层削减选项（CTX-01）。 */
export interface ContextShaperOptions {
  /** 单条工具结果超过该字符数时做头尾裁剪（默认 24,000）。 */
  readonly maxToolChars?: number;
  /**
   * 单条 user/assistant 消息超过该字符数时做头尾裁剪（默认 48,000）。
   *
   * 为什么需要：只裁工具结果时，一条 1 MB 的粘贴日志/大段用户输入会**恒超窗**，
   * 压缩器也救不回来（它只折叠历史，不裁当前消息）⇒ 上游 400、回合硬崩。
   * 阈值取 ~12k token：足够容纳正常长指令，又不会把窗口吃光。
   */
  readonly maxMessageChars?: number;
  /** 何时开始剪旧工具轮：总字符 / (窗口 token × 4) 超过该比例（默认 0.6）。 */
  readonly snipAtRatio?: number;
  /** 至少保留最近多少条工具结果（默认 6）。 */
  readonly keepRecentToolResults?: number;
  /** 上下文窗口 token 数（缺省 128k，用于估算字符预算）。 */
  readonly contextWindowTokens?: number;
  /**
   * 激进模式（默认 false）：为 true 时**额外**剪掉较旧的工具轮。
   *
   * 工具结果的头尾裁剪**不再**受此开关控制（2026-10-21）：裁剪必须对每一条消息
   * 确定性生效，否则「本步只裁最新一条、下一步旧消息恢复全文」会让同一段历史
   * 在请求之间反复改字节——既省不下 token，又从改动点起打断前缀缓存。
   */
  readonly aggressive?: boolean;
}

/** 分层削减报告（可观测，不改变调用方语义）。 */
export interface ContextShaperReport {
  /** 被头尾裁剪的工具结果条数。 */
  readonly trimmedToolResults: number;
  /** 被头尾裁剪的 user/assistant 超大消息条数。 */
  readonly trimmedMessages: number;
  /** 被剪掉的旧工具结果条数。 */
  readonly snippedToolResults: number;
  /** 裁剪前后字符数。 */
  readonly beforeChars: number;
  readonly afterChars: number;
}

/**
 * 上下文分层削减（CTX-01，2026-10-20）。
 *
 * 为什么放在压缩器之前：摘要压缩是**最贵**的一层（要调模型、会丢细节）。在它之前先用
 * 零成本/低成本的两层削掉“明显不该进上下文”的东西——超长工具输出的中段、已经完成且
 * 不再被引用的旧工具轮——能让摘要触发更晚、保留更多近期事实。
 *
 * 两层都是**保守**的：只动 `role:'tool'` 的内容，不动 user/assistant/system；裁剪后统一跑
 * `ToolRoundSanitizer`，避免留下 orphan tool 导致上游 400。
 */
export class ContextShapers {
  /** 默认单条工具结果裁剪阈值（字符）。 */
  public static readonly DEFAULT_MAX_TOOL_CHARS = 24_000;

  /** 默认单条 user/assistant 超大消息裁剪阈值（字符，约 12k token）。 */
  public static readonly DEFAULT_MAX_MESSAGE_CHARS = 48_000;

  /** 默认开始剪旧工具轮的比例。 */
  public static readonly DEFAULT_SNIP_AT_RATIO = 0.6;

  /** 默认保留最近工具结果条数。 */
  public static readonly DEFAULT_KEEP_RECENT_TOOL_RESULTS = 6;

  /**
   * 应用分层削减。
   * @param messages 原始投影消息。
   * @param options 削减选项（缺省使用默认阈值）。
   * @returns 削减后的消息与报告。
   */
  public static apply(
    messages: readonly ModelMessage[],
    options: ContextShaperOptions = {},
  ): { readonly messages: readonly ModelMessage[]; readonly report: ContextShaperReport } {
    const beforeChars = ContextShapers.charsOf(messages);
    const aggressive = options.aggressive === true;
    // 先裁 user/assistant 的超大单条消息，再裁工具结果：后者是常态、前者是兜底。
    const oversized = ContextShapers.trimOversizedMessages(
      messages,
      options.maxMessageChars ?? ContextShapers.DEFAULT_MAX_MESSAGE_CHARS,
    );
    // 2026-10-21：头尾裁剪对所有超长工具结果生效（确定性）。只裁最新一条会让旧消息在
    // 下一步恢复全文，token 省不下来且前缀缓存从该点断裂——这是实测的「每步回滚」缺陷。
    const trimmed = ContextShapers.trimToolResults(
      oversized.messages,
      options.maxToolChars ?? ContextShapers.DEFAULT_MAX_TOOL_CHARS,
    );
    const snipped = aggressive
      ? ContextShapers.snipStaleToolResults(trimmed.messages, {
          snipAtRatio: options.snipAtRatio ?? ContextShapers.DEFAULT_SNIP_AT_RATIO,
          keepRecent:
            options.keepRecentToolResults ?? ContextShapers.DEFAULT_KEEP_RECENT_TOOL_RESULTS,
          contextWindowTokens: options.contextWindowTokens ?? 128_000,
        })
      : { messages: trimmed.messages, count: 0 };
    return {
      messages: snipped.messages,
      report: {
        trimmedToolResults: trimmed.count,
        trimmedMessages: oversized.count,
        snippedToolResults: snipped.count,
        beforeChars,
        afterChars: ContextShapers.charsOf(snipped.messages),
      },
    };
  }

  /**
   * 第零层：单条 user/assistant 超大消息头尾裁剪。
   *
   * 工具结果有外溢器兜底，但 user/assistant 没有——一条 1 MB 的粘贴内容会恒超窗。
   * 保留头 60% + 尾 30%，中段替换为可检索的裁剪标记（确定性，跨步不变）。
   * @param messages 消息列表。
   * @param maxChars 单条阈值。
   * @returns 裁剪后的消息与条数。
   */
  private static trimOversizedMessages(
    messages: readonly ModelMessage[],
    maxChars: number,
  ): { readonly messages: readonly ModelMessage[]; readonly count: number } {
    let count = 0;
    const out = messages.map((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return message;
      if (message.content.length <= maxChars) return message;
      count += 1;
      const head = message.content.slice(0, Math.floor(maxChars * 0.6));
      const tail = message.content.slice(-Math.floor(maxChars * 0.3));
      return {
        ...message,
        content: `${head}\n…（单条消息过长，中段已裁剪 ${String(
          message.content.length - head.length - tail.length,
        )} 字符；如需全文请重新读取源文件/分段发送）…\n${tail}`,
      };
    });
    return { messages: out, count };
  }

  /**
   * 第一层：超长工具结果头尾裁剪（对所有超长结果生效，保证跨步确定性）。
   * @param messages 消息列表。
   * @param maxChars 单条阈值。
   * @returns 裁剪后的消息与条数。
   */
  private static trimToolResults(
    messages: readonly ModelMessage[],
    maxChars: number,
  ): { readonly messages: readonly ModelMessage[]; readonly count: number } {
    let count = 0;
    const out = messages.map((message) => {
      if (message.role !== 'tool' || message.content.length <= maxChars) return message;
      count += 1;
      const head = message.content.slice(0, Math.floor(maxChars * 0.7));
      const tail = message.content.slice(-Math.floor(maxChars * 0.2));
      return {
        ...message,
        content: `${head}\n…（工具结果中段已裁剪 ${String(
          message.content.length - head.length - tail.length,
        )} 字符）…\n${tail}`,
      };
    });
    return { messages: out, count };
  }

  /**
   * 第二层：超过预算比例时剪掉较旧的工具结果（保留最近 N 条）。
   * @param messages 消息列表。
   * @param opts 阈值。
   * @returns 剪枝后的消息与条数。
   */
  private static snipStaleToolResults(
    messages: readonly ModelMessage[],
    opts: {
      readonly snipAtRatio: number;
      readonly keepRecent: number;
      readonly contextWindowTokens: number;
    },
  ): { readonly messages: readonly ModelMessage[]; readonly count: number } {
    const charBudget = opts.contextWindowTokens * 4;
    if (ContextShapers.charsOf(messages) <= charBudget * opts.snipAtRatio) {
      return { messages, count: 0 };
    }
    const toolIndexes: number[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]?.role === 'tool') toolIndexes.push(i);
    }
    if (toolIndexes.length <= opts.keepRecent) {
      return { messages, count: 0 };
    }
    const drop = new Set(toolIndexes.slice(0, toolIndexes.length - opts.keepRecent));
    const kept = messages.filter((_message, index) => !drop.has(index));
    // 剪掉 tool 后必须重新消毒，避免 orphan tool / assistant.tool_calls 缺响应。
    return { messages: ToolRoundSanitizer.sanitizeToolRounds(kept), count: drop.size };
  }

  /**
   * 估算消息字符数（只用于比例判断，不用于计费）。
   * @param messages 消息列表。
   * @returns 字符总数。
   */
  private static charsOf(messages: readonly ModelMessage[]): number {
    return messages.reduce((sum, message) => sum + message.content.length, 0);
  }
}
