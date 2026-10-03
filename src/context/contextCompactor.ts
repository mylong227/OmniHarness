import type { ModelMessage, ModelPort } from '../ports/model/model.js';
import type { ToolDefinition } from '../ports/tool/tool.js';
import type { CompactionState } from '../ports/context/compactionState.js';
import { TokenEstimator, type TokenAccountableMessage } from './tokenEstimator.js';
import { DeterministicCompressor } from './deterministicCompressor.js';
import { log } from '../util/logger.js';
import { ToolRoundSanitizer } from '../util/toolRoundSanitizer.js';
import { ArrayAt } from '../util/arrayAt.js';

/**
 * 每请求的**固定开销**（不随消息增删变化，但确实占用同一 token 预算）。
 *
 * 存在理由（2026-10-03 清偿 PROJECT_BOARD §3-3 的后半）：压缩阈值此前只拿「消息 content 之和」
 * 与预算比较，而真实请求体还包含两块**恒定占用**——
 *  - **工具 schema**：本轮可见工具的名称 + 描述 + JSON Schema 会随请求发出（默认档 30+ 工具实测
 *    可观；`tool_search` 暴露档也一样在请求体里）；
 *  - **repo-map 尾段**：`StepContextBuilder` 在**压缩之后**才把它追加到消息尾部，于是压缩那一刻
 *    完全看不到它（生产档约 1.5K token）。
 * 两者不入账 ⇒ 记账系统性偏低 ⇒ 长会话**越过真实窗口才触发压缩**，下一步直接把超窗请求发给上游
 * （fail-open 到 400）。把固定开销显式预留进同一预算，判据才与真实请求体同源。
 */
export interface RequestOverhead {
  /** 本轮可见的工具定义（schema 会随请求发出）。 */
  readonly tools?: readonly ToolDefinition[] | undefined;
  /** 组装后追加到请求尾部的固定文本（repo-map 动态段；压缩时尚未拼入）。 */
  readonly trailingText?: string | undefined;
}

/** 上下文压缩选项。 */
export interface CompactionOptions {
  readonly maxTokens: number;
  readonly keepRecent: number;
  readonly remoteSummarizer?: (history: string) => Promise<string>;
  /**
   * 模型上下文窗口（token，V2）：提供时压缩阈值 = floor(window × 0.8)，
   * 优先于 maxTokens（对标 codex context_window 百分比 / dsh thresholdRatio 思想）。
   */
  readonly contextWindowTokens?: number;
  /**
   * 发往模型前施加**确定性无损收缩**（默认 true）。
   * 只裁「确定冗余」（行尾空白 / 3+ 连续空行 / 整段 JSON 缩进），不删字符级事实，
   * 幂等且单调 ⇒ 逐轮输出稳定（不破坏 prompt 前缀缓存）。关闭时逐字节回到旧行为。
   */
  readonly deterministicShrink?: boolean;
}

/**
 * 预留固定开销后，仍必须留给消息的预算下限（占基准阈值比例）。
 *
 * 为什么需要下限：预留是「工具 schema + repo-map」这类**不可压缩**的占用，若它已超过阈值，
 * `base - reserved` 会 ≤ 0 ⇒ 压缩会把历史丢到只剩一条（比超窗更糟：用户的历史没了）。
 * 故夹到 20%——此时如实承认「预算已被固定开销吃满」，宁可让上游看到一次偏大的请求，
 * 也不静默清空会话。真正的处置是把窗口调大或收窄工具集，不是把账算到历史头上。
 */
const MIN_BUDGET_SHARE = 0.2;

/** 确定性无损收缩度量（仅统计可收缩角色：user / assistant / tool）。 */
export interface ShrinkReport {
  /** 收缩前字节数（UTF-8）。 */
  readonly beforeBytes: number;
  /** 收缩后字节数（UTF-8）。 */
  readonly afterBytes: number;
  /** 节省字节数（≥ 0）。 */
  readonly savedBytes: number;
  /** 收缩后 / 收缩前 ∈ (0,1]，越小越省；无可收缩内容时为 1。 */
  readonly ratio: number;
}

export type { CompactionState } from '../ports/context/compactionState.js';

/** 上下文压缩结果。 */
export interface CompactionResult {
  readonly messages: readonly ModelMessage[];
  readonly compacted: boolean;
  readonly summary?: string;
  /** V2：本次调用后生效的压缩状态（未压缩为 undefined）。 */
  readonly state?: CompactionState;
  /** 本次发往模型的消息文本的无损收缩度量（关闭收缩时为 undefined）。 */
  readonly shrink?: ShrinkReport;
}

/**
 * 判断位置 `idx` 处的 tool 消息有没有前序 assistant.tool_calls 与之匹配。
 * 用于把 compaction 后会被 DeepSeek/OpenAI HTTP 400 拒收的"orphan tool 块"挪进 head。
 */

/** 结构化摘要模板（对标 dsh compaction-basic 8 段结构，保关键工程信息不丢）。 */
const SUMMARY_TEMPLATE = [
  '你是对话历史压缩器。请把下列历史压缩为结构化摘要，严格按以下小节输出（无内容的节写"无"）：',
  '1. 任务目标：用户的原始意图与验收标准',
  '2. 关键决策：已做出的技术/方案选择及理由',
  '3. 涉及文件：读写过的文件路径及改动要点',
  '4. 错误与修复：遇到的错误、根因、解决方式（未解决的标注"未解决"）',
  '5. 当前进度：已完成/进行中的工作状态',
  '6. 下一步：明确的待办与执行顺序',
  '7. 关键约束：不可违反的约定/环境限制',
  '8. 重要事实：命令输出、配置、数据等后续必需的具体信息',
].join('\n');

/** 压缩事件标记前缀（写回事件日志供崩溃恢复解析）。 */
export const COMPACTION_MARKER = 'OMNI_COMPACTION_V1';

/** 上下文压缩器：超预算时把较早历史折叠为摘要，保留最近消息（无模型则退化为截断）。 */
export class ContextCompactor {
  private readonly estimator = new TokenEstimator();
  /** 确定性无损收缩器（无状态，可安全复用）。 */
  private readonly shrinker = new DeterministicCompressor();
  /** 收缩开关：默认开（选项缺省 undefined 视为开）。 */
  private readonly shrinkEnabled: boolean;
  /**
   * 工具定义 → token 数缓存（按对象引用）。
   *
   * 为什么：固定开销**每步**都要重算（见 {@link RequestOverhead}），而工具定义在会话内是静态的；
   * 不缓存就要每步把 30+ 个 schema 重新 `JSON.stringify`（可测出毫秒级浪费）。
   * 用 WeakMap 而非 Map：注册表热卸载/重载后旧条目可被回收，不构成泄漏。
   */
  private readonly toolTokenCache = new WeakMap<ToolDefinition, number>();

  public constructor(
    private readonly model: ModelPort | undefined,
    private readonly options: CompactionOptions,
  ) {
    this.shrinkEnabled = options.deterministicShrink !== false;
  }

  /**
   * 可收缩角色判定：会话内容（user / assistant / tool）可收缩；system 由 harness 精心编排，不动。
   * @param message 待判定消息。
   * @returns 该消息是否属于可收缩角色。
   */
  private static isShrinkable(message: ModelMessage): boolean {
    return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
  }

  /**
   * 对消息施加**确定性无损收缩**：只改 `content`，不动 toolCalls / reasoningContent /
   * images / files / toolCallId（这些是 wire 层结构与思考模式回传硬要求）。
   * @param messages 待收缩的消息列表。
   * @returns 收缩后的消息与前后字节度量（未开启收缩时原样返回、度量为 undefined）。
   */
  private shrink(messages: readonly ModelMessage[]): {
    readonly messages: readonly ModelMessage[];
    readonly report: ShrinkReport | undefined;
  } {
    if (!this.shrinkEnabled) {
      return { messages, report: undefined };
    }
    let beforeBytes = 0;
    let afterBytes = 0;
    const out = messages.map((message) => {
      if (!ContextCompactor.isShrinkable(message)) {
        return message;
      }
      const before = message.content;
      const after = this.shrinker.shrinkLossless(before);
      beforeBytes += this.shrinker.byteLength(before);
      afterBytes += this.shrinker.byteLength(after);
      return after === before ? message : { ...message, content: after };
    });
    return {
      messages: out,
      report: {
        beforeBytes,
        afterBytes,
        savedBytes: Math.max(0, beforeBytes - afterBytes),
        ratio: beforeBytes === 0 ? 1 : afterBytes / beforeBytes,
      },
    };
  }

  /** 注入原生（Rust 内核）token 估算器：传入后内部估算走原生路径。
   * @returns 无返回值。
   */
  public setNativeEstimator(fn: (messages: readonly TokenAccountableMessage[]) => number): void {
    this.estimator.setNativeEstimator(fn);
  }

  /** 生效压缩阈值：给了 contextWindowTokens 则 0.8×window 优先。 */
  private get threshold(): number {
    if (this.options.contextWindowTokens !== undefined && this.options.contextWindowTokens > 0) {
      return Math.floor(this.options.contextWindowTokens * 0.8);
    }
    return this.options.maxTokens;
  }

  /**
   * 扣除每请求固定开销后的**可用消息预算**（消息估算值与之比较）。
   *
   * 见 {@link RequestOverhead}：工具 schema 与 repo-map 尾段与消息同处一份请求体，
   * 必须一起进预算，否则记账偏低会导致「越过真实窗口才压缩」。
   * @param overhead 本轮固定开销（缺省即 0，行为与改造前逐字一致）。
   * @returns 可用预算（最低夹在基准阈值的 {@link MIN_BUDGET_SHARE} 比例以上）。
   */
  private effectiveThreshold(overhead?: RequestOverhead): number {
    const base = this.threshold;
    const reserved = this.overheadTokens(overhead);
    if (reserved <= 0) {
      return base;
    }
    const floor = Math.max(1, Math.floor(base * MIN_BUDGET_SHARE));
    return Math.max(floor, base - reserved);
  }

  /**
   * 估算每请求固定开销的 token 数（工具 schema 每条按定义对象缓存 + 尾部文本）。
   * @param overhead 本轮固定开销（可缺省）。
   * @returns 固定开销 token 估算值。
   */
  private overheadTokens(overhead?: RequestOverhead): number {
    if (overhead === undefined) {
      return 0;
    }
    let total = 0;
    for (const tool of overhead.tools ?? []) {
      const cached = this.toolTokenCache.get(tool);
      if (cached !== undefined) {
        total += cached;
        continue;
      }
      const tokens = this.estimator.estimate(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      );
      this.toolTokenCache.set(tool, tokens);
      total += tokens;
    }
    const trailing = overhead.trailingText;
    if (trailing !== undefined && trailing !== '') {
      total += this.estimator.estimate(trailing);
    }
    return total;
  }

  /**
   * 游标快路径：状态存在且前缀指纹匹配 → 复用既有摘要（零 LLM 调用），不匹配则返回 undefined
   * 让调用方走主路径重算（自动失效，绝不复用错误摘要）。
   * @param messages 全量消息。
   * @param state 上一步写回的压缩游标。
   * @param budget 扣除固定开销后的可用消息预算（{@link ContextCompactor.effectiveThreshold}）。
   * @returns 复用成功时的结果；无游标 / 游标越界 / 指纹漂移时为 undefined。
   */
  private tryReuseState(
    messages: readonly ModelMessage[],
    state: CompactionState | undefined,
    budget: number,
  ): CompactionResult | undefined {
    if (state === undefined || state.compactedUpTo <= 0 || state.compactedUpTo >= messages.length) {
      return undefined;
    }
    const head = messages.slice(0, state.compactedUpTo);
    if (ContextCompactor.headFingerprint(head) !== state.headHash) {
      log.debug('compaction.state.stale', {
        compactedUpTo: state.compactedUpTo,
        messages: messages.length,
      });
      return undefined;
    }
    const tail = this.shrink(
      ToolRoundSanitizer.sanitizeToolRounds(messages.slice(state.compactedUpTo)),
    );
    // 与主路径**共用**预算组装：否则同一输入在「首次压缩」与「复用游标」下给出不同条数
    // （实测：主路径 2 条、快路径 3 条），既不一致又可能超预算。
    const composed = this.composeWithinBudget(state.summary, tail.messages, budget);
    return {
      messages: composed.messages,
      compacted: true,
      summary: state.summary,
      state,
      ...(tail.report !== undefined ? { shrink: tail.report } : {}),
    };
  }

  /**
   * 按需压缩（V2）：
   *  - 传 `state` 且前缀指纹匹配 → 直接复用既有摘要（零 LLM 调用），
   *    消灭「每步重复摘要」缺陷（审计 P0-1）。
   *  - 指纹不匹配（前缀漂移，如历史被回滚/编辑）→ 自动失效重算，绝不复用错误摘要。
   *  - 不传 state 时行为与旧版逐字节兼容（无游标，每次重算）。
   *
   * `overhead` 为每请求固定开销（工具 schema / repo-map 尾段）：给了就与消息共用同一预算，
   * 判据才与真实请求体同源（见 {@link RequestOverhead}）。**缺省时行为与改造前逐字一致**。
   * @param messages 待压缩消息（已投影但未追加 repo-map 尾段）。
   * @param state 上一步写回的压缩游标（可缺省）。
   * @param overhead 本轮固定开销（可缺省）。
   * @returns 压缩结果（含是否真的压缩、摘要、写回游标与收缩度量）。
   */
  public async compact(
    messages: readonly ModelMessage[],
    state?: CompactionState,
    overhead?: RequestOverhead,
  ): Promise<CompactionResult> {
    const budget = this.effectiveThreshold(overhead);
    // 游标快路径：前缀未漂移 → 复用摘要，不调 LLM。
    const reused = this.tryReuseState(messages, state, budget);
    if (reused !== undefined) {
      return reused;
    }
    const estimated = this.estimator.estimateMessages(messages);
    if (estimated <= budget) {
      // 未达压缩阈值：不折叠历史，但仍施加无损收缩（逐轮可复现 ⇒ 不破坏前缀缓存）。
      const shrunk = this.shrink(messages);
      return {
        messages: shrunk.messages,
        compacted: false,
        ...(shrunk.report !== undefined ? { shrink: shrunk.report } : {}),
      };
    }
    log.debug('compaction.triggered', {
      estimated,
      threshold: budget,
      reserved: this.overheadTokens(overhead),
      keepRecent: this.options.keepRecent,
    });
    // 切 tail 时边界**必须落在工具轮之外**（2026-10-03 修，轮对齐）：
    // tail 起点若是 tool 消息（其 assistant(tool_calls) 被折进 head），或起点恰是
    // assistant(tool_calls)（其 tool 结果留在 tail），都会把一个工具轮从中间切开——
    // summarize 的请求 = head + user 指令 ⇒ 请求以带 tool_calls 却无响应的 assistant 收尾：
    // 宽容端点（OpenAI 兼容）会剥掉 tool_calls 留一条空 assistant，摘要模型**看不到被切开的
    // 那一轮调用**；严格端点（Anthropic / llama.cpp）直接 400，被 summarize 的
    // `catch → '[历史已省略]'` 吞成零信息占位摘要。工具结果在 agent 转录里占绝对多数，
    // 旧边界算法（只躲 orphan tool）在良构投影上从不移动，切轮是常态而非边缘。
    // 算法：边界指到 tool ⇒ 左移穿过全部结果到其 assistant，再把整个轮次让给 tail；
    // 边界指到 assistant(tool_calls) ⇒ 同样左移一位（结果必在其后）。
    const keepCount = Math.min(this.options.keepRecent, messages.length);
    const headEnd = ContextCompactor.roundAlignedBoundary(messages, messages.length - keepCount);
    const tail = this.shrink(ToolRoundSanitizer.sanitizeToolRounds(messages.slice(headEnd)));
    const head = messages.slice(0, headEnd);
    if (head.length === 0) {
      // 无 head 可折叠（keepRecent ≥ 总条数）⇒ 没有摘要可生成，但**绝不能原样透传**：
      // 旧实现在这里返回 tail 却报 `compacted: true` + summary '[历史已省略]'，实测「阈值 100、
      // 输入 4 万字符 → 输出 4 万字符、out===in」，即**假称已压缩、上下文仍超预算**（fail-open：
      // 下一步直接把超窗请求发给端点）。现按真实预算兜底丢弃最旧消息，并如实报告丢弃条数；
      // 若本就在预算内则如实回 `compacted: false`（不谎报）。
      const bounded = this.dropOldestUntilBudget(tail.messages, budget);
      log.info('compaction.done', {
        keepRecent: bounded.messages.length,
        hadModel: this.model !== undefined,
        droppedMessages: bounded.dropped,
        summaryLen: 0,
      });
      return {
        messages: bounded.messages,
        compacted: bounded.dropped > 0,
        ...(bounded.dropped > 0 ? { summary: `[最早 ${bounded.dropped} 条历史已省略]` } : {}),
        ...(tail.report !== undefined ? { shrink: tail.report } : {}),
      };
    }
    const summary = await this.summarize(head);
    const newState: CompactionState = {
      compactedUpTo: headEnd,
      headHash: ContextCompactor.headFingerprint(head),
      summary,
    };
    // 兜底：摘要 + 最近消息**仍超预算**时，丢弃较旧的 tail 消息（保留摘要与最新一条）。
    // 与游标快路径共用同一方法，保证两条路径结果一致。
    const composed = this.composeWithinBudget(summary, tail.messages, budget);
    const final = composed.messages;
    const extraDropped = composed.dropped;
    log.info('compaction.done', {
      keepRecent: final.length - 1,
      hadModel: this.model !== undefined,
      summaryLen: summary.length,
      shrunkBytes: tail.report?.savedBytes ?? 0,
      extraDroppedMessages: extraDropped,
    });
    return {
      messages: final,
      compacted: true,
      summary,
      state: newState,
      ...(tail.report !== undefined ? { shrink: tail.report } : {}),
    };
  }

  /**
   * 组装「摘要 + 最近消息」并保证落入预算：超出时丢弃较旧的 tail 消息（保留摘要与最新一条）。
   *
   * **主路径与游标快路径共用本方法**——两条路径若各自组装，同一输入会给出不同条数
   * （实测：首次压缩 2 条、复用游标 3 条），既不自洽也可能超预算。
   * @param summary 摘要文本（作为首条 system）
   * @param tail 最近消息（已收缩并消毒）
   * @param budget 扣除固定开销后的可用消息预算
   * @returns 预算内的消息数组与**额外丢弃**的条数（0 表示摘要 + 最近消息本就未超预算）
   */
  private composeWithinBudget(
    summary: string,
    tail: readonly ModelMessage[],
    budget: number,
  ): { readonly messages: readonly ModelMessage[]; readonly dropped: number } {
    let final: readonly ModelMessage[] = [{ role: 'system', content: summary }, ...tail];
    let dropped = 0;
    while (final.length > 2 && this.estimator.estimateMessages(final) > budget) {
      const before = final.length;
      const summaryMessage = final[0] as ModelMessage;
      // 丢弃下标 1..（较旧的 tail），保留摘要与最新一条；丢弃后重新消毒避免 orphan tool。
      final = [summaryMessage, ...ToolRoundSanitizer.sanitizeToolRounds(final.slice(2))];
      dropped += before - final.length;
    }
    return { messages: final, dropped };
  }

  /**
   * 预算兜底：结果仍超阈值时，从**最旧**一端逐条丢弃（每次丢弃后重新消毒工具轮次，
   * 避免留下无匹配前序的 orphan tool —— 那会被上游 400 拒收），直到落入预算或只剩一条消息。
   *
   * 这是「无 head 可摘要」时的最后一道防线：宁可丢最旧历史并**如实报告**，
   * 也不能假称已压缩而把超窗请求发出去（旧实现即 fail-open）。
   * @param messages 已折叠/收缩后的候选消息（按时间顺序）
   * @param budget 扣除固定开销后的可用消息预算
   * @returns 预算内的消息与**实际丢弃**的条数（0 表示本就未超预算）
   */
  private dropOldestUntilBudget(
    messages: readonly ModelMessage[],
    budget: number,
  ): {
    readonly messages: readonly ModelMessage[];
    readonly dropped: number;
  } {
    let current = ToolRoundSanitizer.sanitizeToolRounds(messages);
    let dropped = 0;
    while (current.length > 1 && this.estimator.estimateMessages(current) > budget) {
      const before = current.length;
      current = ToolRoundSanitizer.sanitizeToolRounds(current.slice(1));
      dropped += before - current.length;
    }
    return { messages: current, dropped };
  }

  /**
   * 生成历史摘要（V2 三通道：服务端压缩回调 → 本地模型（前缀友好请求）→ 占位）。
   * 前缀友好：摘要请求 = 原样重放 head + 尾部追加一条 user 压缩指令，
   * 使该请求与主请求共享最长公共前缀，命中 provider 的 implicit prompt cache
   * （对标 dsh summarizer 真前缀设计 / codex 保前缀头删策略）。
   */
  private async summarize(head: readonly ModelMessage[]): Promise<string> {
    if (this.options.remoteSummarizer !== undefined) {
      try {
        return await this.options.remoteSummarizer(this.historyText(head));
      } catch (error) {
        // 服务端压缩失败，降级本地（留 debug 痕迹：静默降级曾让「摘要质量塌陷」不可归因）。
        log.debug('compaction.remote_summarizer.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.model === undefined) {
      return '[历史已省略]';
    }
    try {
      const output = await this.model.generate({
        messages: [
          ...head,
          {
            role: 'user',
            content: `${SUMMARY_TEMPLATE}\n\n【历史结束】请输出上述对话历史的结构化摘要，直接给内容，不要寒暄。`,
          },
        ],
        tools: [],
      });
      return output.text ?? '[历史已省略]';
    } catch (error) {
      // 2026-10-03 修：此处曾是纯静默 catch——严格端点（Anthropic/llama.cpp）对畸形摘要请求
      // 回 400 时，整次压缩名义成功、实际拿到零信息占位摘要，事后完全不可归因。留 warn。
      log.warn('compaction.summarize.failed', {
        error: error instanceof Error ? error.message : String(error),
        headMessages: head.length,
      });
      return '[历史已省略]';
    }
  }

  /** 历史文本（服务端压缩回调入参）。 */
  private historyText(head: readonly ModelMessage[]): string {
    return head.map((message) => `${message.role}: ${message.content}`).join('\n');
  }
  /**
   * 把候选边界左移到**工具轮之外**：tail 不得从 tool 消息开始（assistant 已进 head），
   * 也不得从 assistant(tool_calls) 开始（其结果必在 tail）——两者都是把一个工具轮切两半。
   * @param messages 全量消息（良构投影：tool 消息的配对 assistant 必在其前）。
   * @param start 初始候选边界（`messages.length - keepCount`，可为负/越界）。
   * @returns 轮对齐后的边界（≥ 0；0 表示无可折叠 head，走丢弃兜底）。
   */
  private static roundAlignedBoundary(messages: readonly ModelMessage[], start: number): number {
    let headEnd = Math.max(0, Math.min(start, messages.length));
    while (headEnd > 0) {
      const message = ArrayAt.at(messages, headEnd);
      if (message === undefined) {
        break;
      }
      if (message.role === 'tool') {
        // 左移穿过结果，去认领其 assistant（下一轮迭代命中下方分支）。
        headEnd -= 1;
        continue;
      }
      if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
        // 工具轮整体让给 tail（结果必在该 assistant 之后、全在 tail 侧）。
        headEnd -= 1;
        continue;
      }
      break;
    }
    return headEnd;
  }

  /** djb2 前缀指纹（无第三方依赖、稳定、跨进程一致——JSON.stringify 顺序由消息构造方保证）。 */
  public static headFingerprint(messages: readonly ModelMessage[]): string {
    let h = 5381;
    for (const m of messages) {
      const s = `${m.role}\u0000${m.content}\u0000${m.toolCallId ?? ''}`;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      }
    }
    return (h >>> 0).toString(16);
  }

  /**
   * 序列化压缩状态为事件日志文本（崩溃恢复用）：标记行 + 摘要正文。
   * 格式：`OMNI_COMPACTION_V1 upTo=<n> hash=<hex>\n<summary>`
   */
  public static encodeCompactionState(state: CompactionState): string {
    return `${COMPACTION_MARKER} upTo=${state.compactedUpTo} hash=${state.headHash}\n${state.summary}`;
  }

  /** 从事件日志文本解析压缩状态（格式不符返回 undefined，fail-closed）。 */
  public static decodeCompactionState(text: string): CompactionState | undefined {
    const nl = text.indexOf('\n');
    if (nl < 0) {
      return undefined;
    }
    const header = text.slice(0, nl);
    const m = /^OMNI_COMPACTION_V1 upTo=(\d+) hash=([0-9a-f]+)$/.exec(header);
    if (m === null) {
      return undefined;
    }
    const summary = text.slice(nl + 1);
    if (summary === '') {
      return undefined;
    }
    return {
      compactedUpTo: Number(m[1]),
      headHash: m[2] ?? '',
      summary,
    };
  }
}
