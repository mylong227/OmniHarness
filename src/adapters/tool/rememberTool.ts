import { randomUUID } from 'node:crypto';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool/tool.js';
import type { LongTermMemoryPort } from '../../ports/memory/longTermMemory.js';

/**
 * 长期记忆写入工具（#S28）：模型显式沉淀一条跨会话持久的 durable fact
 * （用户偏好 / 项目约定 / 关键决策 / 环境事实 / 踩过的坑）。落盘存活，
 * 与 #M2 `memory_search`（内存会话检索）互补——后者查"刚才聊了啥"，本工具存"值得长期记得啥"。
 */
export class RememberTool {
  /**
   * 工具定义：remember 工具的名称、描述与参数 schema。
   * 把一条值得长期跨会话保留的 durable fact 写入长期记忆，进程重启后仍可经 recall 回忆。
   */
  public readonly definition: ToolDefinition = {
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

  /**
   * @param memory 长期记忆端口（事实落盘与计数均经它）。
   */
  public constructor(private readonly memory: LongTermMemoryPort) {}

  /** 写入一条长期记忆事实。
   * @param call 工具调用（实参含 fact，可选 topic/importance）。
   * @param context 工具上下文（取 sessionId 记录事实来源会话）。
   * @returns 执行结果：JSON 文本含存储标志、事实 id 与当前总数；fact 为空返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
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
