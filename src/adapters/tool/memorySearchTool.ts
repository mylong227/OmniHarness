import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { RetrievalPort } from '../../ports/retrieval.js';

/** memory_search 默认返回片段数上限。 */
const DEFAULT_LIMIT = 5;

/**
 * @beta
 * 会话检索工具（#M2）：模型用自然语言在已发生的会话历史中检索相关片段，
 * 实现跨长对话的 recall，而无需把全部历史塞进上下文。命中经 `RetrievalPort` 返回。
 */
export class MemorySearchTool {
  readonly definition: ToolDefinition = {
    name: 'memory_search',
    description:
      '在已发生的会话历史（用户输入、助手回复、工具输出、系统说明）中按自然语言检索相关片段，用于跨长对话的 recall。返回命中片段的文本与角色，便于在不把所有历史塞进上下文的前提下回忆此前讨论过的细节、决定或关键信息。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '自然语言查询，如「之前提到的数据库连接串」「我们决定用 Rust 内核的原因」「上一步 shell 输出了什么」',
        },
        limit: { type: 'number', description: '返回片段数上限（默认 5）' },
        session: { type: 'string', description: '可选：仅在该会话 ID 内检索（缺省跨全部会话）' },
      },
      required: ['query'],
    },
  };

  constructor(private readonly retrieval: RetrievalPort) {}

  /** 执行检索并返回命中片段。 */
  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const query = String(call.arguments['query'] ?? '').trim();
    if (query === '') {
      return { callId: call.id, ok: false, error: 'query 不能为空' };
    }
    const limit =
      typeof call.arguments['limit'] === 'number'
        ? Math.max(1, Math.floor(call.arguments['limit'] as number))
        : DEFAULT_LIMIT;
    const session =
      typeof call.arguments['session'] === 'string'
        ? (call.arguments['session'] as string)
        : undefined;
    const hits = this.retrieval.search(query, limit, session);
    const payload = hits.map((hit) => ({
      sessionId: hit.doc.sessionId,
      role: hit.doc.role,
      text: hit.doc.text,
      score: hit.score,
    }));
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({ count: hits.length, results: payload }, null, 2),
    };
  }
}
