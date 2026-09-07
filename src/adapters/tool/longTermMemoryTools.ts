import { randomUUID } from 'node:crypto';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LongTermMemoryPort } from '../../ports/longTermMemory.js';

/** 默认召回条数。 */
const DEFAULT_RECALL_LIMIT = 5;

/**
 * 长期记忆写入工具（#S28）：模型显式沉淀一条跨会话持久的 durable fact
 * （用户偏好 / 项目约定 / 关键决策 / 环境事实 / 踩过的坑）。落盘存活，
 * 与 #M2 `memory_search`（内存会话检索）互补——后者查"刚才聊了啥"，本工具存"值得长期记得啥"。
 */
export class RememberTool {
  readonly definition: ToolDefinition = {
    name: 'remember',
    description:
      '把一条值得长期跨会话保留的事实写入长期记忆（用户偏好、项目约定、关键决策、环境事实、踩过的坑、对用户的承诺等）。写入后即便进程重启也会保留，并在未来会话中经 recall 被回忆起。仅写真正 durable 的信息，临时输出与可被重新检索的琐碎内容不要用本工具。',
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description:
            '简短、可独立复用的事实陈述，如「用户要求所有 TS 文件用 camelCase」「项目禁用第三方 npm 依赖」「PMS bug 5135058 根因是抽面颜色矩阵被覆盖」',
        },
        topic: {
          type: 'string',
          description: '可选主题分类，如「编码规范」「项目约定」「环境」「待办」',
        },
        importance: { type: 'number', description: '重要度 1..5（默认 3），5 表示最该留' },
      },
      required: ['fact'],
    },
  };

  constructor(private readonly memory: LongTermMemoryPort) {}

  /** 写入一条长期记忆事实。 */
  async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const factText = String(call.arguments['fact'] ?? '').trim();
    if (factText === '') {
      return { callId: call.id, ok: false, error: 'fact 不能为空' };
    }
    const topic =
      typeof call.arguments['topic'] === 'string' ? (call.arguments['topic'] as string) : undefined;
    const rawImportance =
      typeof call.arguments['importance'] === 'number'
        ? (call.arguments['importance'] as number)
        : 3;
    const importance = Math.min(5, Math.max(1, Math.round(rawImportance)));
    const fact = {
      id: randomUUID(),
      text: factText,
      topic,
      importance,
      createdAt: new Date().toISOString(),
      sessionId: context.sessionId,
      source: 'tool' as const,
    };
    this.memory.remember(fact);
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({ stored: true, id: fact.id, count: this.memory.count }, null, 2),
    };
  }
}

/**
 * 长期记忆召回工具（#S28）：用自然语言从跨会话持久事实中检索 top-k，
 * 使模型在新会话里"想起"此前的偏好/约定/决策/坑。
 */
export class RecallTool {
  readonly definition: ToolDefinition = {
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

  constructor(private readonly memory: LongTermMemoryPort) {}

  /** 召回相关长期记忆事实。 */
  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
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
