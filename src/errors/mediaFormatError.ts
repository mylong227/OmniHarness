import { ErrorCode, OmniError } from '../omniError.js';

/**
 * 媒体格式错误：字节流不符合容器规范（GIF 块结构非法、LZW 码流损坏、调色板越界等）。
 *
 * 为什么单独成类（而不是抛裸 `Error`）：解码失败的原因决定上层处置——
 * 「文件不是这个格式」应转成对模型**可行动**的提示（换工具 / 换文件），
 * 而「文件损坏」应如实上报为提取失败。带稳定错误码才能被日志与上层策略区分。
 */
export class MediaFormatError extends OmniError {
  /** 出错时已解析到的字节偏移（用于定位损坏点）；未知为 `undefined`。 */
  public readonly offset: number | undefined;

  /**
   * @param message 错误信息（透传给 `OmniError`）。
   * @param offset 出错处的字节偏移（可选）。
   */
  public constructor(message: string, offset?: number) {
    super(ErrorCode.MEDIA_FORMAT_ERROR, message);
    this.offset = offset;
  }
}
