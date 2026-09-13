import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { EventPort } from '../../../ports/runtime/eventPort.js';
import type { EventFactoryPort } from '../../../ports/runtime/eventFactory.js';
import type {
  AskOption,
  AskQuestion,
  UserResponder,
} from '../../../ports/runtime/userResponder.js';

/**
 * @beta
 * `ask_user`：向用户抛出结构化问题并暂停，等回答后作为工具结果喂回循环。
 * 对标 dsh `packages/interaction/tool-ask-user`（工具名 `ask_user_question`）。
 *
 * 回答经 {@link UserResponder} 端口获取——TTY 走 ConsoleUserResponder，无人值守
 * 走 DefaultUserResponder（fail-soft 返回空选择），测试/前端可注入自定义实现。
 */
export class AskUserTool {
  /**
   * 工具定义：ask_user 工具的名称、描述与参数 schema。
   * 让模型向用户抛出结构化单选/多选/开放问题，等回答后回灌循环。
   */
  public readonly definition: ToolDefinition = {
    name: 'ask_user',
    description:
      '在确实需要用户做选择、确认或提供关键缺失信息时向用户提问。可一次问多个问题，每个带稳定 id（答案回显）。' +
      '需要选择时给 options；想推荐某项就放第一并追加 "(推荐)"。' +
      '严禁用此工具澄清模糊指令（如用户说"重新试试"），遇到这种情况应基于上下文直接执行而非反问。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '向用户提出的问题。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '稳定 id，答案中原样回显' },
              question: { type: 'string', description: '具体问题' },
              header: { type: 'string', description: '可选短标题，如"确认"/"选择模式"' },
              options: {
                type: 'array',
                description: '可选选项；label 为展示文案，description 一句取舍说明',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: '是否允许多选，默认 false' },
            },
          },
        },
      },
      required: ['questions'],
    },
  };

  public constructor(
    private readonly responder: UserResponder,
    private readonly events: EventPort | undefined,
    private readonly eventFactory: EventFactoryPort,
  ) {}

  /**
   * 执行 ask_user 工具调用：校验 questions、经 UserResponder 取回答并广播 question 事件。
   * @param call 模型传入的工具调用（含 questions 数组）。
   * @param ctx 工具执行上下文（取 sessionId 用于事件广播）。
   * @returns 成功时 output 为答案 JSON；questions 非数组或为空时返回 ok:false。
   */
  public async handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const raw = call.arguments['questions'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { callId: call.id, ok: false, error: 'questions 必须是非空数组' };
    }
    const questions: AskQuestion[] = raw.map((entry, i) => {
      const e = entry as Record<string, unknown>;
      const id = typeof e['id'] === 'string' ? (e['id'] as string) : `q${i}`;
      const question = typeof e['question'] === 'string' ? (e['question'] as string) : '';
      const q: {
        id: string;
        question: string;
        header?: string;
        options?: AskOption[];
        multiSelect?: boolean;
      } = {
        id,
        question,
      };
      if (typeof e['header'] === 'string') {
        q.header = e['header'] as string;
      }
      if (Array.isArray(e['options'])) {
        q.options = (e['options'] as Record<string, unknown>[]).map((o) => {
          const label = String(o['label'] ?? '');
          return typeof o['description'] === 'string'
            ? { label, description: o['description'] as string }
            : { label };
        });
      }
      if (typeof e['multi_select'] === 'boolean') {
        q.multiSelect = e['multi_select'] as boolean;
      }
      return q as AskQuestion;
    });
    this.events?.emit(this.eventFactory.question(ctx.sessionId, questions));
    const answers = await this.responder.ask(questions);
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({ answers }),
    };
  }
}
