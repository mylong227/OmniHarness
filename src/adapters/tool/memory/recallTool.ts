import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LongTermMemoryPort } from '../../../ports/memory/longTermMemory.js';

/** 默认召回条数。 */
const DEFAULT_RECALL_LIMIT = 5;

/**
 * 长期记忆召回工具（#S28）：用自然语言从跨会话持久事实中检索 top-k，
 * 使模型在新会话里"想起"此前的偏好/约定/决策/坑。
 */
export class RecallTool {
  /**
   * 工具定义：recall 工具的名称、描述与参数 schema。
   * 从长期记忆（跨会话持久事实）按自然语言召回条目，用于新会话对齐既有约定。
   */
  public readonly definition: ToolDefinition = {
    name: 'recall',
    description:
      '从长期记忆（跨会话持久事实）中按自然语言召回相关条目，用于在新会话里回忆用户偏好、项目约定、关键决策或此前踩过的坑。返回命中事实的文本与主题，便于在开工前先对齐既有约定。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '自然语言查询，如「编码规范」「禁用第三方依赖」「PMS bug 的约定」「用户偏好」',
        },
        limit: { type: 'number', description: '返回条数上限（默认 5）' },
      },
      required: ['query'],
    },
  };

  /**
   * @param memory 长期记忆端口（召回与打分/衰减由它负责）。
   */
  public constructor(private readonly memory: LongTermMemoryPort) {}

  /** 召回相关长期记忆事实。
   * @param call 工具调用（实参含 query，可选 limit）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：JSON 文本含命中数与各事实（主题/文本/重要度）；query 为空返回失败。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const query = String(call.arguments['query'] ?? '').trim();
    if (query === '') {
      return { callId: call.id, ok: false, error: 'query 不能为空' };
    }
    const limit =
      typeof call.arguments['limit'] === 'number'
        ? Math.max(1, Math.floor(call.arguments['limit'] as number))
        : DEFAULT_RECALL_LIMIT;
    const hits = this.memory.recall(query, limit);
    const payload = hits.map((fact) => ({
      topic: fact.topic,
      text: fact.text,
      importance: fact.importance,
    }));
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({ count: hits.length, results: payload }, null, 2),
    };
  }
}
