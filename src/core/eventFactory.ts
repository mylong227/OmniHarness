import type { SessionEvent } from '../ports/event.js';
import type { ImageContent, FileAttachment, ModelUsage } from '../ports/model.js';
import { id } from '../util/id.js';

/** 事件工厂：统一构造各类会话事件，保证结构一致。 */
export class EventFactory {
  /** 构造一条用户事件（images/files 可选，多模态输入，#B1/#B5）。 */
  static user(
    sessionId: string,
    content: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): SessionEvent {
    const payload: Record<string, unknown> = { content };
    if (images !== undefined && images.length > 0) {
      payload['images'] = images;
    }
    if (files !== undefined && files.length > 0) {
      payload['files'] = files;
    }
    return this.base(sessionId, 'user', payload);
  }

  /** 构造一条助手事件。 */
  /**
   * 构造一条助手事件。reasoning 可选：DeepSeek v4 等推理模型的思考链，
   * 直接挂在 payload.reasoning 上供 contextAssembler 投影时取用，避免依赖
   * 「reasoning 事件先于 assistant 事件到达」的脆弱顺序假设（#OBS-5）。
   */
  static assistant(sessionId: string, content: string, reasoning?: string): SessionEvent {
    const payload: Record<string, unknown> = { content };
    if (reasoning !== undefined && reasoning !== '') {
      payload['reasoning'] = reasoning;
    }
    return this.base(sessionId, 'assistant', payload);
  }

  /** 构造一条推理事件。 */
  static reasoning(sessionId: string, content: string): SessionEvent {
    return this.base(sessionId, 'reasoning', { content });
  }

  /** 构造一条工具调用事件。 */
  static toolCall(
    sessionId: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): SessionEvent {
    return this.base(sessionId, 'tool_call', { callId, name, args });
  }

  /** 构造一条工具结果事件（undefined 字段不写入，保证 JSON 往返一致）。 */
  static toolResult(
    sessionId: string,
    callId: string,
    ok: boolean,
    output?: string,
    error?: string,
  ): SessionEvent {
    const payload: Record<string, unknown> = { callId, ok };
    if (output !== undefined) {
      payload['output'] = output;
    }
    if (error !== undefined) {
      payload['error'] = error;
    }
    return this.base(sessionId, 'tool_result', payload);
  }

  /** 构造一条系统事件（压缩点等内部说明）。 */
  static system(sessionId: string, content: string): SessionEvent {
    return this.base(sessionId, 'system', { content });
  }

  /** 构造一条待办快照事件（`todo_write` 触发，UI 折叠用）。 */
  static todo(
    sessionId: string,
    todos: readonly { content: string; status: string }[],
  ): SessionEvent {
    return this.base(sessionId, 'todo', { todos });
  }

  /** 构造一条计划态事件（`plan_write` / `plan_present` 触发）。 */
  static plan(sessionId: string, plan: unknown): SessionEvent {
    return this.base(sessionId, 'plan', plan);
  }

  /** 构造一条提问事件（`ask_user` 触发，记录模型向人抛出的问题）。 */
  static question(sessionId: string, questions: unknown): SessionEvent {
    return this.base(sessionId, 'question', { questions });
  }

  /** 构造一条回合级变更事件（#M5，payload 为本回合 unified diff）。 */
  static turnDiff(sessionId: string, diff: string): SessionEvent {
    return this.base(sessionId, 'turn_diff', { diff });
  }

  /**
   * 构造一条模型用量事件（#S29 / live 跑分成本计量）；payload 透传 usage。
   * modelName 可选：带上后 UI 的 token 统计表可按真实模型名分组（缺省归入 unknown）。
   */
  static model(sessionId: string, usage: ModelUsage, modelName?: string): SessionEvent {
    return this.base(sessionId, 'model', { usage, model: modelName });
  }

  /**
   * 构造会话元数据事件（新会话首条）：标记创建时的工作区，供 UI 按项目收纳会话。
   * 仅落日志与广播，上下文投影器不消费该类型（不进模型上下文）。
   */
  static sessionMeta(sessionId: string, workspace: string): SessionEvent {
    return this.base(sessionId, 'session_meta', { workspace });
  }

  /** 构造事件基座。 */
  private static base(
    sessionId: string,
    type: SessionEvent['type'],
    payload: unknown,
  ): SessionEvent {
    return {
      id: id(),
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      payload,
    };
  }
}
