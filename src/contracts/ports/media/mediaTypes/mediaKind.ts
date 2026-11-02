/** 媒体大类（决定走哪条提取通道）。 */
export type MediaKind =
  /** 动画 GIF（纯 TS 解码，零外部二进制）。 */
  | 'gif'
  /** 视频容器（需要本机 ffmpeg） */
  | 'video'
  /** 静态图片（由 `view_image` 负责，本层只用于给出可行动的转介提示）。 */
  | 'image'
  /** 无法识别。 */
  | 'unknown';
