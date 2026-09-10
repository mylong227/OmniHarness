import { OmniError, ErrorCode } from '../errors.js';

/** 单张图像输入（URL 或 base64，供多模态截图/UI 理解，#B1）。 */
export interface ImageContent {
  /** http(s) / file:// / data URI。 */
  readonly url?: string;
  /** base64 编码（需配合 mediaType）。 */
  readonly data?: string;
  /** MIME 类型，如 'image/png'。 */
  readonly mediaType?: string;
}

/**
 * 通用文件附件（多模态输入扩展，#B5）：图片/视频/任意文件随用户消息送入。
 * 图片类（mediaType 以 image/ 开头）由模型适配器作为图像理解；其余以文本说明注入模型上下文。
 */
export interface FileAttachment {
  /** 原始文件名。 */
  readonly name: string;
  /** MIME 类型，如 'image/png' / 'video/mp4' / 'application/pdf'。 */
  readonly mediaType: string;
  /** base64 编码（需配合 mediaType）。 */
  readonly data?: string;
  /** http(s) / file:// / data URI（与 data 二选一）。 */
  readonly url?: string;
}

/** 模型消息（OpenAI 兼容最小子集）。 */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** 随消息附带的图像（可选，向后兼容：缺省退化为纯文本，#B1）。 */
  readonly images?: readonly ImageContent[];
  /**
   * 随消息附带的文件附件（可选，#B5）：图片/视频/任意文件。
   * 图片类文件与 images 一并理解；其余以文本说明注入模型上下文。
   */
  readonly files?: readonly FileAttachment[];
  /**
   * 助手回合携带的工具调用（OpenAI 多轮工具格式）。
   * 存在时本消息在 wire 层序列化为 assistant.tool_calls；同一回合可同时含 content。
   */
  readonly toolCalls?: readonly ModelToolCallRef[];
  /**
   * 工具结果消息关联的工具调用 id（OpenAI 多轮工具格式：role:'tool' 必须带 tool_call_id，
   * 且须与前置 assistant 消息的某条 tool_calls.id 对应）。
   */
  readonly toolCallId?: string;
  /**
   * 助手回合的思考文本（DeepSeek 思考模式等多步推理模型的 reasoning_content）。
   * DeepSeek v4 思考模式硬性要求把上一轮 assistant 的 reasoning_content 原样回传，
   * 缺失即 HTTP 400（"The `reasoning_content` in the thinking mode must be passed back"）。
   */
  readonly reasoningContent?: string;
}

/** 工具说明（供模型 schema）。 */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** 模型请求。 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolSpec[];
  /** 推理强度（可选，#B6）：透传为 OpenAI reasoning_effort 等，未设则后端按模型默认。 */
  readonly reasoningEffort?: string;
  /**
   * 取消信号（V2，可选）：透传给底层 fetch 实现协作式取消。
   * 未提供时适配器行为不变（向后兼容）；提供时取消即中断在飞 HTTP 请求。
   */
  readonly signal?: AbortSignal;
}

/** 模型返回的工具调用引用。 */
export interface ModelToolCallRef {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** 模型输出：推理 / 文本 / 工具调用。 */
export interface ModelOutput {
  readonly reasoning?: string;
  readonly text?: string;
  readonly toolCalls?: readonly ModelToolCallRef[];
  /** 本次调用的 token 用量（成本计量 / 硬预算熔断依据，#S29）。未上报时为 undefined。 */
  readonly usage?: ModelUsage;
}

/** 模型用量统计（token 级，#S29）。 */
export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** 流式工具输入增量（#B3）：模型边生成工具参数边推送，用于渐进渲染工具调用参数。 */
export interface ToolInputDelta {
  /** 工具调用 id（Anthropic 在 block start 给出，OpenAI 在首个 tool_calls delta 给出）。 */
  readonly id?: string;
  /** 工具名。 */
  readonly name?: string;
  /** 已累积的参数片段（JSON 片段，可能不完整，由消费方自行拼接/解析）。 */
  readonly partialJson: string;
}

/** 模型流式回调。 */
export interface StreamCallbacks {
  readonly onText: (text: string) => void;
  /** 工具输入增量（可选；模型不支持或不触发工具时不调用）。 */
  readonly onToolInput?: (delta: ToolInputDelta) => void;
}

/** 模型端口：任意 AI（OpenAI 兼容 / Anthropic / 本地 / 自研）的统一插口。 */
export interface ModelPort {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelOutput>;
  stream?(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput>;
}

/** 模型调用错误（结构化，便于重试决策；#M6）。 */
export class ModelCallError extends OmniError {
  /** HTTP 状态码（网络层错误为 undefined）。 */
  public readonly status?: number;
  /** 是否可重试（429/408/5xx 通常可重试，4xx 客户端错误通常不可）。 */
  public readonly retryable: boolean;
  /** 服务端建议的等待毫秒数（Retry-After 头解析结果）。 */
  public readonly retryAfterMs?: number;

  public constructor(
    message: string,
    opts: { readonly status?: number; readonly retryable: boolean; readonly retryAfterMs?: number },
  ) {
    super(ErrorCode.MODEL_CALL_ERROR, message);
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 路由定价：某模型每百万 token 的输入 / 输出单价（USD，#S29）。 */
export interface RoutePrice {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

/** 成本预算耗尽错误（#S29）：硬预算熔断时抛出，fail-closed 阻止后续模型调用。 */
export class BudgetExceededError extends OmniError {
  /** 预算上限（USD）。 */
  public readonly limitUsd: number;
  /** 已花费（USD）。 */
  public readonly spentUsd: number;
  /** 被阻断的模型名。 */
  public readonly model: string;

  public constructor(
    message: string,
    info: { readonly limitUsd: number; readonly spentUsd: number; readonly model: string },
  ) {
    super(ErrorCode.BUDGET_EXCEEDED, message);
    this.limitUsd = info.limitUsd;
    this.spentUsd = info.spentUsd;
    this.model = info.model;
  }
}
