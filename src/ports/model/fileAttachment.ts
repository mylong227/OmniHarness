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
