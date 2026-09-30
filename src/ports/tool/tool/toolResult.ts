import type { FileAttachment } from '../../model/model.js';

/** 工具执行结果。 */
export interface ToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  /**
   * 工具产出的**文件附件**（可选，P2-⑬）：供 `view_image` 这类「把字节交给模型」的工具使用。
   * 图片类附件由模型适配器作为图像理解；其余以文本说明注入模型上下文。
   *
   * 通道走向：工具结果事件 → 上下文组装器 → 模型消息。组装器会把它们作为**独立的一条
   * user 消息**追加在所有 tool 消息之后（而不是塞进 tool 消息内）——OpenAI 兼容端点不保证
   * tool 消息能携带分段内容，且把附件插在 tool 消息之间会破坏 tool_call 配对。
   */
  readonly files?: readonly FileAttachment[] | undefined;
}
