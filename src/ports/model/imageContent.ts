/** 单张图像输入（URL 或 base64，供多模态截图/UI 理解，#B1）。 */
export interface ImageContent {
  /** http(s) / file:// / data URI。 */
  readonly url?: string;
  /** base64 编码（需配合 mediaType）。 */
  readonly data?: string;
  /** MIME 类型，如 'image/png'。 */
  readonly mediaType?: string;
}
