import type { SessionEvent } from '../ports/runtime/event.js';
import type {
  ImageContent,
  FileAttachment,
  ModelContextSnapshot,
  ModelUsage,
} from '../ports/model/model.js';
import type { EventFactoryPort } from '../ports/runtime/eventFactory.js';
import { id } from '../util/id.js';

/**
 * 事件工厂：统一构造各类会话事件，保证结构一致。
 *
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 * 无隐式状态，同一实例可并发复用（默认实例见文件末尾组合根门面）。
 */
export class EventFactory implements EventFactoryPort {
  /**
   * 构造一条用户事件（images/files 可选，多模态输入，#B1/#B5）。
   * @param sessionId 事件归属的会话 ID。
   * @param content 用户消息文本。
   * @param images 可选图片内容数组（非空才写入 payload）。
   * @param files 可选文件附件数组（非空才写入 payload）。
   * @returns 结构完整的 user 事件（未落盘，由调用方决定去留）。
   */
  public user(
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

  /**
   * 构造一条助手事件。
   * @param sessionId 事件归属的会话 ID。
   * @param content 助手回复文本。
   * @param reasoning 可选思考链文本（非空才写入 payload.reasoning）。
   * @returns 结构完整的 assistant 事件。
   */
  /**
   * 构造一条助手事件。reasoning 可选：DeepSeek v4 等推理模型的思考链，
   * 直接挂在 payload.reasoning 上供 contextAssembler 投影时取用，避免依赖
   * 「reasoning 事件先于 assistant 事件到达」的脆弱顺序假设（#OBS-5）。
   * @param sessionId 事件归属的会话 ID。
   * @param content 助手回复文本。
   * @param reasoning 可选思考链文本（非空才写入 payload.reasoning）。
   * @returns 结构完整的 assistant 事件。
   */
  public assistant(sessionId: string, content: string, reasoning?: string): SessionEvent {
    const payload: Record<string, unknown> = { content };
    if (reasoning !== undefined && reasoning !== '') {
      payload['reasoning'] = reasoning;
    }
    return this.base(sessionId, 'assistant', payload);
  }

  /**
   * 构造一条推理事件。
   * @param sessionId 事件归属的会话 ID。
   * @param content 推理/思考过程文本。
   * @returns 结构完整的 reasoning 事件。
   */
  public reasoning(sessionId: string, content: string): SessionEvent {
    return this.base(sessionId, 'reasoning', { content });
  }

  /**
   * 构造一条工具调用事件。
   * @param sessionId 事件归属的会话 ID。
   * @param callId 调用 ID（与对应 tool_result 配对）。
   * @param name 被调用工具名。
   * @param args 工具入参（原始 JSON 对象）。
   * @returns 结构完整的 tool_call 事件。
   */
  public toolCall(
    sessionId: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): SessionEvent {
    return this.base(sessionId, 'tool_call', { callId, name, args });
  }

  /**
   * 构造一条工具结果事件（undefined 字段不写入，保证 JSON 往返一致）。
   * @param sessionId 事件归属的会话 ID。
   * @param callId 对应 tool_call 的调用 ID（配对键）。
   * @param ok 工具是否执行成功。
   * @param output 成功时的输出文本（可选，undefined 不写入 payload）。
   * @param error 失败时的错误文本（可选，undefined 不写入 payload）。
   * @param files 工具产出的文件附件（可选，非空才写入 payload；见 ToolResult.files）。
   * @returns 结构完整的 tool_result 事件。
   */
  public toolResult(
    sessionId: string,
    callId: string,
    ok: boolean,
    output?: string,
    error?: string,
    files?: readonly FileAttachment[],
  ): SessionEvent {
    const payload: Record<string, unknown> = { callId, ok };
    if (output !== undefined) {
      payload['output'] = output;
    }
    if (error !== undefined) {
      payload['error'] = error;
    }
    if (files !== undefined && files.length > 0) {
      payload['files'] = files;
    }
    return this.base(sessionId, 'tool_result', payload);
  }

  /**
   * 构造一条系统事件（压缩点等内部说明）。
   * @param sessionId 事件归属的会话 ID。
   * @param content 系统说明文本（投影进模型上下文的 system 角色）。
   * @returns 结构完整的 system 事件。
   */
  public system(sessionId: string, content: string): SessionEvent {
    return this.base(sessionId, 'system', { content });
  }

  /**
   * 构造一条待办快照事件（`todo_write` 触发，UI 折叠用）。
   * @param sessionId 事件归属的会话 ID。
   * @param todos 当前全量待办列表（content + status）。
   * @returns 结构完整的 todo 事件。
   */
  public todo(
    sessionId: string,
    todos: readonly { content: string; status: string }[],
  ): SessionEvent {
    return this.base(sessionId, 'todo', { todos });
  }

  /**
   * 构造一条计划态事件（`plan_write` / `plan_present` 触发）。
   * @param sessionId 事件归属的会话 ID。
   * @param plan 计划内容对象（结构由计划工具定义）。
   * @returns 结构完整的 plan 事件。
   */
  public plan(sessionId: string, plan: unknown): SessionEvent {
    return this.base(sessionId, 'plan', plan);
  }

  /**
   * 构造一条提问事件（`ask_user` 触发，记录模型向人抛出的问题）。
   * @param sessionId 事件归属的会话 ID。
   * @param questions 问题列表（结构由 ask_user 工具定义）。
   * @returns 结构完整的 question 事件。
   */
  public question(sessionId: string, questions: unknown): SessionEvent {
    return this.base(sessionId, 'question', { questions });
  }

  /**
   * 构造一条回合级变更事件（#M5，payload 为本回合 unified diff）。
   * @param sessionId 事件归属的会话 ID。
   * @param diff 本回合累积的 unified diff 文本。
   * @returns 结构完整的 turn_diff 事件。
   */
  public turnDiff(sessionId: string, diff: string): SessionEvent {
    return this.base(sessionId, 'turn_diff', { diff });
  }

  /**
   * 构造一条模型用量事件（#S29 / live 跑分成本计量）；payload 透传 usage。
   * modelName 可选：带上后 UI 的 token 统计表可按真实模型名分组（缺省归入 unknown）。
   * context 可选：本次请求的上下文占用快照（实测），供 UI 容量面板读取——
   * 不传则 payload 无 context 字段，读取侧退回投影重算（标为估算）。
   * @param sessionId 事件归属的会话 ID。
   * @param usage 本次模型调用的 token 用量与成本计量。
   * @param modelName 产生该用量的模型名（缺省归入 unknown）。
   * @param context 可选的上下文占用快照（实测口径，供 UI 容量面板直读）。
   * @returns 结构完整的 model 事件。
   */
  public model(
    sessionId: string,
    usage: ModelUsage,
    modelName?: string,
    context?: ModelContextSnapshot,
  ): SessionEvent {
    const payload: Record<string, unknown> = { usage, model: modelName };
    if (context !== undefined) {
      payload['context'] = context;
    }
    return this.base(sessionId, 'model', payload);
  }

  /**
   * 构造会话元数据事件（新会话首条）：标记创建时的工作区，供 UI 按项目收纳会话。
   * 仅落日志与广播，上下文投影器不消费该类型（不进模型上下文）。
   * @param sessionId 事件归属的会话 ID。
   * @param workspace 创建会话时的工作区根目录。
   * @returns 结构完整的 session_meta 事件。
   */
  public sessionMeta(sessionId: string, workspace: string): SessionEvent {
    return this.base(sessionId, 'session_meta', { workspace });
  }

  /**
   * 构造事件基座。
   * @param sessionId 事件归属的会话 ID。
   * @param type 事件类型（SessionEvent 联合类型的成员名）。
   * @param payload 事件负载（各类型自定义结构）。
   * @returns 带唯一 ID 与 ISO 时间戳的完整会话事件。
   */
  private base(sessionId: string, type: SessionEvent['type'], payload: unknown): SessionEvent {
    return {
      id: id(),
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      payload,
    };
  }
}

/** 默认事件工厂实例（无状态，调用点以 `eventFactory.xxx(...)` 零构造复用）。 */
export const eventFactory = new EventFactory();
