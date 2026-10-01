import type { GifFrameTiming } from './gifFrameTiming.js';
import type { GifDecodedFrame } from './gifDecodedFrame.js';

/** 解码结果（含完整的结构统计，供探测与采样使用）。 */
export interface GifAnimation {
  /** 逻辑屏宽度。 */
  readonly width: number;
  /** 逻辑屏高度。 */
  readonly height: number;
  /** 循环次数（0＝无限）。 */
  readonly loopCount: number;
  /** 源中的**总帧数**（无论是否被选中）。 */
  readonly frameCount: number;
  /** 动画总时长（毫秒，按归一化后的帧延迟累加）。 */
  readonly totalDurationMs: number;
  /** 帧时间轴（长度等于已扫描帧数；`skipPixels` 模式下同样可用）。 */
  readonly timeline: readonly GifFrameTiming[];
  /** 被选中并解码的帧（按时间升序）。 */
  readonly frames: readonly GifDecodedFrame[];
  /** 因码流不完整而受损的帧数（如实上报，不静默）。 */
  readonly damagedFrameCount: number;
  /** 是否因 `stopAfterIndex` 而提前停止解码（此时结构统计为「至少这么多」，不是全量）。 */
  readonly truncated: boolean;
}
