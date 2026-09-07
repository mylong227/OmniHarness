import type { ModelMessage, ModelPort } from '../ports/model.js';
import { TokenEstimator } from './tokenEstimator.js';
import { log } from '../util/logger.js';

/** 上下文压缩选项。 */
export interface CompactionOptions {
  readonly maxTokens: number;
  readonly keepRecent: number;
  readonly remoteSummarizer?: (history: string) => Promise<string>;
}

/** 上下文压缩结果。 */
export interface CompactionResult {
  readonly messages: readonly ModelMessage[];
  readonly compacted: boolean;
  readonly summary?: string;
}

/**
 * 判断位置 `idx` 处的 tool 消息有没有前序 assistant.tool_calls 与之匹配。
 * 用于把 compaction 后会被 DeepSeek/OpenAI HTTP 400 拒收的"orphan tool 块"挪进 head。
 */
function isToolOrphan(messages: readonly ModelMessage[], idx: number): boolean {
  const m = messages[idx];
  if (m === undefined || m.role !== 'tool') return false;
  const id = m.toolCallId;
  if (id === undefined) return false;
  for (let j = idx - 1; j >= 0; j--) {
    const prev = messages[j]!;
    if (prev.role !== 'assistant') return false; // 找不到匹配的 assistant，停止向前搜
    if (prev.toolCalls?.some((c) => c.id === id)) return false; // 找到了合法前置
  }
  return true; // 头方向没找到 assistant.tool_calls.id 匹配 → 孤儿
}

/** 上下文压缩器：超预算时把较早历史折叠为摘要，保留最近消息（无模型则退化为截断）。 */
export class ContextCompactor {
  private readonly estimator = new TokenEstimator();

  constructor(
    private readonly model: ModelPort | undefined,
    private readonly options: CompactionOptions,
  ) {}

  /** 注入原生（Rust 内核）token 估算器：传入后内部估算走原生路径。 */
  setNativeEstimator(fn: (messages: readonly { content: string }[]) => number): void {
    this.estimator.setNativeEstimator(fn);
  }

  /** 按需压缩。 */
  async compact(messages: readonly ModelMessage[]): Promise<CompactionResult> {
    const estimated = this.estimator.estimateMessages(messages);
    if (estimated <= this.options.maxTokens) {
      return { messages, compacted: false };
    }
    log.debug('compaction.triggered', {
      estimated,
      maxTokens: this.options.maxTokens,
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
    const tail = messages.slice(headEnd);
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
    log.info('compaction.done', {
      keepRecent: tail.length,
      hadModel: this.model !== undefined,
      summaryLen: summary.length,
    });
    return { messages: [{ role: 'system', content: summary }, ...tail], compacted: true, summary };
  }

  /** 生成历史摘要（双通道：优先服务端压缩回调，否则本地模型，最后占位）。 */
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
      const output = await this.model.generate({ messages: this.summaryRequest(head), tools: [] });
      return output.text ?? '[历史已省略]';
    } catch {
      return '[历史已省略]';
    }
  }

  /** 历史文本（服务端压缩回调入参）。 */
  private historyText(head: readonly ModelMessage[]): string {
    return head.map((message) => `${message.role}: ${message.content}`).join('\n');
  }

  /** 构造摘要请求消息。 */
  private summaryRequest(head: readonly ModelMessage[]): ModelMessage[] {
    const history = this.historyText(head);
    return [
      {
        role: 'system',
        content: '你是对话历史压缩器。请把下列历史压缩为简短摘要，保留关键事实与用户意图。',
      },
      { role: 'user', content: history },
    ];
  }
}
