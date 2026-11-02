/** 帧时间轴条目（**不含像素**，故逐帧收集也不占内存）。 */
export interface GifFrameTiming {
  /** 源中的帧序号（0 起）。 */
  readonly sourceIndex: number;
  /** 该帧起始时间（毫秒，自 0 累加）。 */
  readonly timestampMs: number;
  /** 该帧显示时长（毫秒）。 */
  readonly delayMs: number;
}
