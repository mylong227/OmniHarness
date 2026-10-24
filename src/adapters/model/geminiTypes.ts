import type { ModelMessage, ModelUsage } from '../../ports/model/model.ts';

/**
 * Gemini 原生协议的 wire 类型（只描述本适配器实际读写的字段，避免把整份官方 schema 抄进来）。
 *
 * 单独成文件而不是塞在 `geminiModel.ts`：后者已接近仓库 810 行上限，协议形状与请求/响应
 * 编排是两件事，拆开后两边都更容易审阅（不新增任何运行时逻辑，纯类型）。
 */

/** Gemini 角色（原生协议只有 user / model）。 */
export type GeminiRole = 'user' | 'model';

/** 请求侧消息的附件字段子集（避免把整个 ModelMessage 依赖带进转换器）。 */
export type MessageWithAttachments = Pick<ModelMessage, 'images' | 'files'>;

/** 单条 Gemini 消息内容。 */
export interface GeminiContent {
  /** 角色。 */
  readonly role: GeminiRole;
  /** 内容分片（相邻同角色消息会被合并到此数组）。 */
  readonly parts: GeminiWirePart[];
}

/** Gemini wire 分片（请求与响应共用；未出现的字段即不发）。 */
export interface GeminiWirePart {
  /** 文本。 */
  readonly text?: string;
  /** 是否为思考文本（仅响应侧）。 */
  readonly thought?: boolean;
  /** 函数调用（model 内容）。 */
  readonly functionCall?: GeminiFunctionCall;
  /** 函数结果（user 内容）。 */
  readonly functionResponse?: GeminiFunctionResponse;
  /** 内联二进制（图像 / PDF）。 */
  readonly inlineData?: GeminiInlineData;
}

/** Gemini 函数调用。 */
export interface GeminiFunctionCall {
  /** 调用 id（官方新版本返回；缺省时由适配器合成）。 */
  readonly id?: string;
  /** 函数名。 */
  readonly name?: string;
  /** 参数（对象；兼容端点可能给 JSON 字符串）。 */
  readonly args?: unknown;
}

/** Gemini 函数结果。 */
export interface GeminiFunctionResponse {
  /** 配对 id（与 functionCall 的 id 对应）。 */
  readonly id?: string;
  /** 函数名（Gemini 的必填配对键）。 */
  readonly name: string;
  /** 结果载荷（Gemini 要求是对象）。 */
  readonly response: Record<string, unknown>;
}

/** Gemini 内联二进制。 */
export interface GeminiInlineData {
  /** MIME 类型。 */
  readonly mimeType: string;
  /** 纯 base64（不带 data URI 前缀）。 */
  readonly data: string;
}

/** Gemini 非流式响应（最小子集）。 */
export interface GeminiResponse {
  /** 候选回答。 */
  readonly candidates?: readonly GeminiCandidate[];
  /** token 用量。 */
  readonly usageMetadata?: GeminiUsageMetadata;
  /** 提示级反馈（安全拦截时给 blockReason，可能没有 candidate）。 */
  readonly promptFeedback?: GeminiPromptFeedback;
}

/** 单个候选回答。 */
export interface GeminiCandidate {
  /** 内容。 */
  readonly content?: GeminiCandidateContent;
  /** 结束原因。 */
  readonly finishReason?: string | null;
}

/** 候选回答的内容。 */
export interface GeminiCandidateContent {
  /** 内容分片。 */
  readonly parts?: readonly GeminiWirePart[];
}

/** 提示级反馈。 */
export interface GeminiPromptFeedback {
  /** 安全拦截原因（如 SAFETY / OTHER）。 */
  readonly blockReason?: string;
}

/** 流式帧：与普通响应同形，另可携带 `error` 负载。 */
export interface GeminiStreamFrame extends GeminiResponse {
  /** 流中错误负载（出现即中断流并抛结构化错误）。 */
  readonly error?: GeminiErrorPayload;
}

/** Gemini 用量元数据。 */
export interface GeminiUsageMetadata {
  /** 输入 token 数（含缓存命中部分）。 */
  readonly promptTokenCount?: number;
  /** 命中缓存的输入 token 数。 */
  readonly cachedContentTokenCount?: number;
  /** 输出候选 token 数。 */
  readonly candidatesTokenCount?: number;
  /** 思考 token 数。 */
  readonly thoughtsTokenCount?: number;
  /** 总 token 数。 */
  readonly totalTokenCount?: number;
}

/** Gemini 错误负载（HTTP 错误体与流中 error 帧同形）。 */
export interface GeminiErrorPayload {
  /** 数字状态码（流中错误帧常带）。 */
  readonly code?: number;
  /** 可读消息。 */
  readonly message?: string;
  /** 字符串状态（如 RESOURCE_EXHAUSTED）。 */
  readonly status?: string;
}

/** 流式累积中的工具调用（arguments 可变，便于同 id 帧合并）。 */
export interface GeminiStreamCall {
  /** 调用 id。 */
  id: string;
  /** 函数名。 */
  name: string;
  /** 已合并参数。 */
  arguments: Record<string, unknown>;
}

/** 流式累积状态。 */
export interface GeminiStreamState {
  /** 文本增量。 */
  textChunks: string[];
  /** 思考增量（不进入正文、不推 onText）。 */
  reasoningChunks: string[];
  /** 工具调用（按 id 去重合并）。 */
  calls: GeminiStreamCall[];
  /** 同名调用计数器（缺 id 时合成唯一 id）。 */
  toolCounts: Map<string, number>;
  /** 末帧用量（覆盖写）。 */
  usage?: ModelUsage | undefined;
  /** 结束原因（取最后一个非空值）。 */
  finishReason?: string | undefined;
}
