import type { ModelMessage, ModelPort } from '../ports/model.js';
import { TokenEstimator } from './tokenEstimator.js';
import { log } from '../util/logger.js';
import { sanitizeToolRounds } from '../util/toolRoundSanitizer.js';

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
}

/** 压缩状态（V2 游标）：已被摘要覆盖的前缀长度 + 前缀指纹。持久化后可跨步复用摘要。 */
export interface CompactionState {
  /** 原始投影消息序列中被摘要覆盖的消息数（前缀长度）。 */
  readonly compactedUpTo: number;
  /** 前缀指纹（djb2），用于校验投影前缀未漂移。 */
  readonly headHash: string;
  /** 摘要文本。 */
  readonly summary: string;
}

/** 上下文压缩结果。 */
export interface CompactionResult {
  readonly messages: readonly ModelMessage[];
  readonly compacted: boolean;
  readonly summary?: string;
  /** V2：本次调用后生效的压缩状态（未压缩为 undefined）。 */
  readonly state?: CompactionState;
}

/**
 * 判断位置 `idx` 处的 tool 消息有没有前序 assistant.tool_calls 与之匹配。
 * 用于把 compaction 后会被 DeepSeek/OpenAI HTTP 400 拒收的"orphan tool 块"挪进 head。
 */
function isToolOrphan(messages: readonly ModelMessage[], idx: number): boolean {
  const m = messages[idx];
  if (m === undefined || m.role !== 'tool') return false;
  const id = m.toolCallId;
  if (id === undefined) return true; // 无 toolCallId 的 tool 消息无法被前置调用认领
  for (let j = idx - 1; j >= 0; j--) {
    const prev = messages[j]!;
    if (prev.role === 'assistant' && prev.toolCalls?.some((c) => c.id === id)) {
      return false; // 找到匹配的 assistant.tool_calls.id
    }
  }
  return true; // 到头都没找到匹配的前置 assistant → 孤儿
}

/** djb2 前缀指纹（零依赖、稳定、跨进程一致——JSON.stringify 顺序由消息构造方保证）。 */
export function headFingerprint(messages: readonly ModelMessage[]): string {
  let h = 5381;
  for (const m of messages) {
    const s = `${m.role}\u0000${m.content}\u0000${m.toolCallId ?? ''}`;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
  }
  return (h >>> 0).toString(16);
}

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

  public constructor(
    private readonly model: ModelPort | undefined,
    private readonly options: CompactionOptions,
  ) {}

  /** 注入原生（Rust 内核）token 估算器：传入后内部估算走原生路径。 */
  public setNativeEstimator(fn: (messages: readonly { content: string }[]) => number): void {
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
   * 按需压缩（V2）：
   *  - 传 `state` 且前缀指纹匹配 → 直接复用既有摘要（零 LLM 调用），
   *    消灭「每步重复摘要」缺陷（审计 P0-1）。
   *  - 指纹不匹配（前缀漂移，如历史被回滚/编辑）→ 自动失效重算，绝不复用错误摘要。
   *  - 不传 state 时行为与旧版逐字节兼容（无游标，每次重算）。
   */
  public async compact(
    messages: readonly ModelMessage[],
    state?: CompactionState,
  ): Promise<CompactionResult> {
    // 游标快路径：前缀未漂移 → 复用摘要，不调 LLM。
    if (state !== undefined && state.compactedUpTo > 0 && state.compactedUpTo < messages.length) {
      const head = messages.slice(0, state.compactedUpTo);
      if (headFingerprint(head) === state.headHash) {
        const tail = sanitizeToolRounds(messages.slice(state.compactedUpTo));
        return {
          messages: [{ role: 'system', content: state.summary }, ...tail],
          compacted: true,
          summary: state.summary,
          state,
        };
      }
      log.debug('compaction.state.stale', {
        compactedUpTo: state.compactedUpTo,
        messages: messages.length,
      });
    }
    const estimated = this.estimator.estimateMessages(messages);
    if (estimated <= this.threshold) {
      return { messages, compacted: false };
    }
    log.debug('compaction.triggered', {
      estimated,
      threshold: this.threshold,
      keepRecent: this.options.keepRecent,
    });
    // 切 tail 时必须保证 boundary 落在合法角色上：
    // tail 起点若是 tool 消息且没有匹配的前序 assistant.tool_calls.id，就会变成
    // "orphan tool"，下一次重发时被 DeepSeek/OpenAI HTTP 400 拒收（"Messages with
    // role 'tool' must be a response to a preceding message with 'tool_calls'"，
    // 2026-09-08 真机复现）。
    //
    // 算法：从 messages.length - keepCount 向左挪，直到 tail 起点不是 orphan tool。
    const keepCount = Math.min(this.options.keepRecent, messages.length);
    let headEnd = messages.length - keepCount;
    while (headEnd > 0 && isToolOrphan(messages, headEnd)) headEnd--;
    const tail = sanitizeToolRounds(messages.slice(headEnd));
    const head = messages.slice(0, headEnd);
    if (head.length === 0) {
      log.info('compaction.done', {
        keepRecent: tail.length,
        hadModel: this.model !== undefined,
        summaryLen: 0,
      });
      return { messages: tail, compacted: true, summary: '[历史已省略]' };
    }
    const summary = await this.summarize(head);
    const newState: CompactionState = {
      compactedUpTo: headEnd,
      headHash: headFingerprint(head),
      summary,
    };
    log.info('compaction.done', {
      keepRecent: tail.length,
      hadModel: this.model !== undefined,
      summaryLen: summary.length,
    });
    return {
      messages: [{ role: 'system', content: summary }, ...tail],
      compacted: true,
      summary,
      state: newState,
    };
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
      } catch {
        // 服务端压缩失败，降级本地
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
            content:
              `${SUMMARY_TEMPLATE}\n\n【历史结束】请输出上述对话历史的结构化摘要，直接给内容，不要寒暄。`,
          },
        ],
        tools: [],
      });
      return output.text ?? '[历史已省略]';
    } catch {
      return '[历史已省略]';
    }
  }

  /** 历史文本（服务端压缩回调入参）。 */
  private historyText(head: readonly ModelMessage[]): string {
    return head.map((message) => `${message.role}: ${message.content}`).join('\n');
  }
}

/**
 * 序列化压缩状态为事件日志文本（崩溃恢复用）：标记行 + 摘要正文。
 * 格式：`OMNI_COMPACTION_V1 upTo=<n> hash=<hex>\n<summary>`
 */
export function encodeCompactionState(state: CompactionState): string {
  return `${COMPACTION_MARKER} upTo=${state.compactedUpTo} hash=${state.headHash}\n${state.summary}`;
}

/** 从事件日志文本解析压缩状态（格式不符返回 undefined，fail-closed）。 */
export function decodeCompactionState(text: string): CompactionState | undefined {
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
