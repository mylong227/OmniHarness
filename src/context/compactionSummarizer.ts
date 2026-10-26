/**
 * 压缩摘要生成器（单类，2026-10-25 从 `ContextCompactor` 抽出）。
 *
 * 支持两种模式：
 * - 全量：把整个 head 重放给摘要模型；
 * - 增量（F6）：已有摘要作为 system 种子 + 新增段，提示模型输出「更新后的完整摘要」。
 */
import type { ModelMessage, ModelPort } from '../ports/model/model.ts';
import { ReasoningBudget } from '../util/reasoningBudget.ts';
import { log } from '../util/logger.ts';

/** 结构化摘要模板。 */
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

/** 摘要生成器。 */
export class CompactionSummarizer {
  /**
   * @param model 摘要模型（undefined ⇒ 占位摘要）。
   * @param remoteSummarizer 服务端摘要回调（优先，失败降级本地）。
   */
  public constructor(
    private readonly model: ModelPort | undefined,
    private readonly remoteSummarizer: ((history: string) => Promise<string>) | undefined,
  ) {}

  /**
   * 生成摘要。
   * @param head 本次待摘要的消息（增量模式下只有新增段）。
   * @param previous 已有摘要（F6 种子）；undefined 表示全量摘要。
   * @returns 摘要文本。
   */
  public async summarize(head: readonly ModelMessage[], previous?: string): Promise<string> {
    if (this.remoteSummarizer !== undefined) {
      try {
        const history =
          previous === undefined
            ? this.historyText(head)
            : `【已有摘要】\n${previous}\n【新增历史】\n${this.historyText(head)}`;
        return await this.remoteSummarizer(history);
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
          ...(previous === undefined
            ? []
            : [
                {
                  role: 'system' as const,
                  content: `【已有摘要】\n${previous}\n\n请把它与新增历史合并为更新后的完整摘要，保留仍然有效的信息，不要只总结新增部分。`,
                },
              ]),
          ...head,
          {
            role: 'user',
            content:
              previous === undefined
                ? `${SUMMARY_TEMPLATE}\n\n【历史结束】请输出上述对话历史的结构化摘要，直接给内容，不要寒暄。`
                : `${SUMMARY_TEMPLATE}\n\n【历史结束】请输出**更新后的完整摘要**（已有摘要 + 新增历史），直接给内容，不要寒暄。`,
          },
        ],
        tools: [],
        role: 'compactor',
        // 结构化 8 段摘要不需要深度思考；输出上限防「摘要模型生成 20k token」的成本尖峰。
        reasoningEffort: ReasoningBudget.auxiliary('compactor', undefined),
        maxOutputTokens: 3_000,
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
}
