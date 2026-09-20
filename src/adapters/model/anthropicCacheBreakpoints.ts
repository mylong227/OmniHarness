/**
 * Anthropic Messages API 的**滚动缓存断点**规划器。
 *
 * 动机（缺口修复）：仓库原先只在 `system` 上打了一个 `cache_control: {type:'ephemeral'}`
 * 断点——Anthropic 的提示缓存是**前缀缓存**，可复用区间是「最后一个断点之前的所有内容」。
 * 单一 system 断点意味着多轮会话里**每一轮新追加的 user/assistant 往返都不在可复用区间内**，
 * 长会话的增量前缀永远重算、重付费。Anthropic 允许**每个请求最多 4 个断点**，
 * 故正确形态是「system 一个 + 最近若干轮的 user 消息若干个」的**滚动窗口**：
 * 第 N 轮打在第 N-1 轮的 user 消息上的断点，到第 N+1 轮就成了命中区间的一部分。
 *
 * 本类只做**纯函数式**的位置规划（给定 system + wire messages ⇒ 决策），
 * 不做网络、不碰 fetch，因此可零依赖单测；`anthropicModel` 只负责把结果拼进请求体。
 *
 * 三条硬约束（均有单测）：
 *  1. 断点总数 ≤ 4（Anthropic 上限），system 优先保位，其余名额给**最近**的轮次；
 *  2. 不在轮次不足时乱打断点（首轮只有 1 条 user 消息时**不打**消息断点——
 *     首轮没有任何可复用前缀，打了也只是白占额度）；
 *  3. 断点只落在**非空 text block** 上，避免生成 `cache_control` 挂在空内容上的非法结构。
 */

/** wire 层 content block 的最小结构（只声明本类需要读取的字段）。 */
export type AnthropicWireBlock = Record<string, unknown>;

/** wire 层消息（`content` 可为纯字符串或 block 数组）。 */
export interface AnthropicWireMessage {
  /** 角色（system 已由适配器剥离，此处只应出现 user/assistant）。 */
  readonly role: string;
  /** 内容：纯文本或分段 block 数组。 */
  readonly content: string | readonly AnthropicWireBlock[];
}

/** 断点规划结果。 */
export interface AnthropicBreakpointPlan {
  /** 带断点的 wire 消息数组（未命中断点的消息保持原引用，不复制）。 */
  readonly messages: readonly AnthropicWireMessage[];
  /** 实际打出的消息侧断点数（不含 system 那一个）。 */
  readonly messageBreakpoints: number;
  /** 是否给 system 保留了一个断点（`system` 已剥离且非空时为 true）。 */
  readonly systemBreakpoint: boolean;
}

/** Anthropic 允许的单请求缓存断点上限。 */
export const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/** ephemeral 缓存断点标记（与适配器请求体里 system 上用的同一形态）。 */
const EPHEMERAL: Readonly<Record<string, unknown>> = Object.freeze({ type: 'ephemeral' });

/** 一处可打断点的候选位置：消息下标 + 消息内的 block 锚点（字符串内容无锚点）。 */
interface BreakpointSite {
  /** 消息在数组中的下标。 */
  readonly index: number;
  /** 消息内要挂断点的 block 下标；字符串内容（整体包成一个 block）时为 undefined。 */
  readonly anchor: number | undefined;
}

/**
 * 滚动缓存断点规划器（无状态，可安全并发复用）。
 */
export class AnthropicCacheBreakpoints {
  /**
   * plan — 规划消息侧的滚动缓存断点。
   *
   * 策略（**为什么不是打在最新的 user 消息上**）：Anthropic 的提示缓存是**字节前缀**缓存，
   * 「可复用」的前提是本地新请求的字节流**逐字节以旧请求开头**。若把断点打在本轮最新的
   * user 消息上，该消息在上一轮是以「纯字符串」形态发出的，而本轮被改写成带 `cache_control`
   * 的 block 数组——字节就此分歧，上一轮真正缓存下来的内容反而全部落在分歧点之后，白打。
   * 故滚动窗口停在**已完成的轮次**上：本轮只给「上一轮就原样发出过」的那些 user 消息打断点，
   * 于是第 N 轮的断点位置在第 N+1 轮仍是逐字节前缀（单测锁定该不变量）。
   *
   * 名额：system 占 1 个（存在时），其余从倒数第二条 user 消息往前分配。
   * @param messages 适配器已剥离 system 后的 wire 消息数组。
   * @param hasSystem 是否存在非空 system 段（决定可用名额是 3 还是 4）。
   * @returns 规划结果：带断点的消息数组 + 断点计数（不含 system）。
   */
  public plan(
    messages: readonly AnthropicWireMessage[],
    hasSystem: boolean,
  ): AnthropicBreakpointPlan {
    const sites = this.candidateSites(messages);
    const budget = ANTHROPIC_MAX_CACHE_BREAKPOINTS - (hasSystem ? 1 : 0);
    // 最新的 user 消息（sites 末位）本轮不打断点：它的字节本轮才首次成形，缓存它等于没缓存。
    const completed = sites.slice(0, Math.max(0, sites.length - 1));
    if (completed.length === 0) {
      return { messages, messageBreakpoints: 0, systemBreakpoint: hasSystem };
    }
    const chosen = completed.slice(Math.max(0, completed.length - budget));
    return {
      messages: this.applyAt(messages, chosen),
      messageBreakpoints: chosen.length,
      systemBreakpoint: hasSystem,
    };
  }

  /**
   * 取所有 user 消息构成的候选位置（只认有可挂锚点的消息：非空字符串内容或非空 text block）。
   * 空文本块会在收候选时就被淘汰——否则「计了断点却没真挂上」会让上限口径失真。
   * @param messages wire 消息数组。
   * @returns 升序候选位置数组（最新的一条在末尾）。
   */
  private candidateSites(messages: readonly AnthropicWireMessage[]): BreakpointSite[] {
    const sites: BreakpointSite[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (message === undefined || message.role !== 'user') continue;
      if (typeof message.content === 'string') {
        if (message.content.length > 0) sites.push({ index: i, anchor: undefined });
        continue;
      }
      const anchor = this.anchorOf(message);
      if (anchor !== undefined) sites.push({ index: i, anchor });
    }
    return sites;
  }

  /**
   * 找出该消息里可挂断点的最后一个非空 text block 下标。
   * @param message wire 消息（内容为 block 数组）。
   * @returns block 下标；数组为空或无任何非空 text block 时返回 undefined。
   */
  private anchorOf(message: AnthropicWireMessage): number | undefined {
    const content = message.content;
    if (typeof content === 'string' || content.length === 0) return undefined;
    let anchor: number | undefined;
    for (let i = 0; i < content.length; i += 1) {
      if (this.isNonEmptyTextBlock(content[i])) anchor = i;
    }
    return anchor;
  }

  /**
   * 判定 block 是否为「可挂断点的非空文本块」。
   * @param block 待判定的 block（可能为 undefined，越界取值安全）。
   * @returns 是 text 类型且 text 为非空字符串时返回 true。
   */
  private isNonEmptyTextBlock(block: AnthropicWireBlock | undefined): boolean {
    if (block === undefined || block['type'] !== 'text') return false;
    const text = block['text'];
    return typeof text === 'string' && text.length > 0;
  }

  /**
   * 对指定消息挂断点，其余消息保持原引用（不复制未命中的消息）。
   * @param messages 原始 wire 消息数组。
   * @param chosen 需要挂断点的候选位置（下标 + 锚点）。
   * @returns 新的消息数组（只有被选中的下标会被替换为新对象）。
   */
  private applyAt(
    messages: readonly AnthropicWireMessage[],
    chosen: readonly BreakpointSite[],
  ): readonly AnthropicWireMessage[] {
    const byIndex = new Map(chosen.map((site) => [site.index, site.anchor]));
    return messages.map((message, index) =>
      byIndex.has(index) ? this.withBreakpoint(message, byIndex.get(index)) : message,
    );
  }

  /**
   * 返回挂了断点的消息副本（字符串内容包成单 block 数组，数组内容只改锚点 block）。
   * @param message 原始 wire 消息。
   * @param anchor 要挂断点的 block 下标；undefined 表示字符串内容整体包成一个 block。
   * @returns 带 cache_control 的消息副本；无可挂位置时返回原消息。
   */
  private withBreakpoint(
    message: AnthropicWireMessage,
    anchor: number | undefined,
  ): AnthropicWireMessage {
    if (typeof message.content === 'string') {
      if (message.content.length === 0) return message;
      return {
        role: message.role,
        content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL }],
      };
    }
    if (anchor === undefined) return message;
    const content = message.content.map((block, index) =>
      index === anchor ? { ...block, cache_control: EPHEMERAL } : block,
    );
    return { role: message.role, content };
  }
}
