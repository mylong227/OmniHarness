import type { MediaFrame, MediaProbeInfo } from '../mediaTypes.js';

/** 帧提取结果。 */
export interface FrameExtractionResult {
  /** 按时间升序的帧集合（可能为空——空集合必须带 `notes` 说明原因，不静默）。 */
  readonly frames: readonly MediaFrame[];
  /** 解码后**更精确**的元数据（如 GIF 需要解出全部块才能确定的帧数/总时长）。 */
  readonly probe: MediaProbeInfo;
  /** 人类可读的过程说明：缩放、丢弃、截断、提前停止等，逐条回灌给模型。 */
  readonly notes: readonly string[];
  /** 是否未覆盖完整采样窗口（预算/超时/帧数上限导致提前收尾）。 */
  readonly truncated: boolean;
}
