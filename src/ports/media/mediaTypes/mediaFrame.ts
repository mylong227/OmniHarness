/** 一帧已编码的图片（交付给模型的最小单位）。 */
export interface MediaFrame {
  /** 在**本次采样结果**中的序号（从 0 起，按时间升序）。 */
  readonly index: number;
  /** 该帧在源中的时间点（毫秒）。 */
  readonly timestampMs: number;
  /** 编码后宽度（像素）。 */
  readonly width: number;
  /** 编码后高度（像素）。 */
  readonly height: number;
  /** 该帧在源中的持续时长（毫秒）；未知为 `undefined`。 */
  readonly durationMs: number | undefined;
  /** 图片 MIME 类型（本实现恒为 `image/png`）。 */
  readonly mediaType: string;
  /** 图片字节。 */
  readonly bytes: Buffer;
}
