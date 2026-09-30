import type { ImageContent } from './imageContent.js';
import type { FileAttachment } from './fileAttachment.js';
import type { ModelToolCallRef } from './modelToolCallRef.js';

/** 模型消息（OpenAI 兼容最小子集）。 */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** 随消息附带的图像（可选，向后兼容：缺省退化为纯文本，#B1）。 */
  readonly images?: readonly ImageContent[] | undefined;
  /**
   * 随消息附带的文件附件（可选，#B5）：图片/视频/任意文件。
   * 图片类文件与 images 一并理解；其余以文本说明注入模型上下文。
   */
  readonly files?: readonly FileAttachment[] | undefined;
  /**
   * 助手回合携带的工具调用（OpenAI 多轮工具格式）。
   * 存在时本消息在 wire 层序列化为 assistant.tool_calls；同一回合可同时含 content。
   */
  readonly toolCalls?: readonly ModelToolCallRef[] | undefined;
  /**
   * 工具结果消息关联的工具调用 id（OpenAI 多轮工具格式：role:'tool' 必须带 tool_call_id，
   * 且须与前置 assistant 消息的某条 tool_calls.id 对应）。
   */
  readonly toolCallId?: string | undefined;
  /**
   * 助手回合的思考文本（DeepSeek 思考模式等多步推理模型的 reasoning_content）。
   * DeepSeek v4 思考模式硬性要求把上一轮 assistant 的 reasoning_content 原样回传，
   * 缺失即 HTTP 400（"The `reasoning_content` in the thinking mode must be passed back"）。
   */
  readonly reasoningContent?: string | undefined;
}
