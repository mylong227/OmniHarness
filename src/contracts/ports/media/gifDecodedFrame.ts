/** 已解码的一帧（RGBA 像素 + 它在动画中的时间点）。 */
export interface GifDecodedFrame {
  /** 画布像素（宽 × 高 × 4，RGBA，非预乘）。 */
  readonly rgba: Uint8Array;
  /** 画布宽度。 */
  readonly width: number;
  /** 画布高度。 */
  readonly height: number;
  /** 该帧显示时长（毫秒）。 */
  readonly delayMs: number;
  /** 该帧在动画中的起始时间（毫秒，自 0 累加）。 */
  readonly timestampMs: number;
  /** 该帧在源中的序号（0 起，**不等同于** `frames` 数组下标——后者只含被选中的帧）。 */
  readonly sourceIndex: number;
}
