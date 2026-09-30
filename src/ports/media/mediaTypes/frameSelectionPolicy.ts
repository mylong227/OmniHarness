import type { FrameStrategy } from './frameStrategy.js';

/** 帧提取的采样与预算约束（全部有默认值，见 `MediaConfigResolver`）。 */
export interface FrameSelectionPolicy {
  /** 采样策略。 */
  readonly strategy: FrameStrategy;
  /** 最多交付多少帧（同时是解码与内存的硬上界）。 */
  readonly maxFrames: number;
  /** 采样窗口起点（毫秒，含）。 */
  readonly startMs: number;
  /** 采样窗口终点（毫秒，含）；`undefined` = 到源结尾。 */
  readonly endMs: number | undefined;
  /** 场景采样阈值（0–1，含义见 {@link FrameStrategy}）；`uniform` 时忽略。 */
  readonly sceneThreshold: number;
  /** 单帧长边上限（像素）：超出即等比缩小。 */
  readonly maxDimension: number;
  /** 单帧字节上限：超出即继续缩小，仍超则丢弃该帧并如实记录。 */
  readonly maxFrameBytes: number;
  /** 本次交付的总字节上限：超出即按时间均匀裁剪帧集合。 */
  readonly maxTotalBytes: number;
}
