/**
 * 媒体流事实（探测/解析的中间结果）——**不含**「属于哪一大类」的判定。
 *
 * 为什么与 `ports/media` 的 `MediaProbeInfo` 分开：解析器（ffprobe JSON / ffmpeg stderr）
 * 只负责「从字节或文本里读出事实」，不应该知道调用方的分类语义与后续路由；
 * 「这是视频还是 GIF、要不要按动画处理」由装配层决定。分开之后，
 * 同一份事实可以被 GIF 路径与视频路径复用，解析器也可以只用真实样本单测。
 */
export interface MediaStreamFacts {
  /** 容器 / 格式名（如 `mov,mp4,m4a,3gp,3g2,mj2`）；未知为 `undefined`。 */
  readonly container: string | undefined;
  /** 视频编码名（如 `h264`）；未知为 `undefined`。 */
  readonly codec: string | undefined;
  /** 宽度（像素）。 */
  readonly width: number | undefined;
  /** 高度（像素）。 */
  readonly height: number | undefined;
  /** 时长（毫秒）。 */
  readonly durationMs: number | undefined;
  /** 帧数；未知为 `undefined`。 */
  readonly frameCount: number | undefined;
  /** 平均帧率（帧/秒）。 */
  readonly frameRate: number | undefined;
}
