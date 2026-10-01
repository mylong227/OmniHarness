import type { VideoFrameFormat } from './mediaTypes/videoFrameFormat.js';

/** 媒体分析配置（`OmniHarnessConfig.media`，全部可选，缺省用下表的默认值）。 */
export interface MediaAnalysisConfig {
  /** ffmpeg 可执行文件路径（最高优先级；配错即报错，不静默回落）。 */
  readonly ffmpegPath?: string | undefined;
  /** ffprobe 可执行文件路径（缺省时按 PATH / ffmpeg 同目录自动查找）。 */
  readonly ffprobePath?: string | undefined;
  /** 单次交付的帧数上限。 */
  readonly maxFrames?: number | undefined;
  /** 单帧长边上限（像素）。 */
  readonly maxDimension?: number | undefined;
  /** 单帧字节上限。 */
  readonly maxFrameBytes?: number | undefined;
  /** 单次交付的总字节上限。 */
  readonly maxTotalBytes?: number | undefined;
  /** 源文件体积上限（GIF 需整份读入内存）。 */
  readonly maxInputBytes?: number | undefined;
  /** 单次提取超时（毫秒）。 */
  readonly timeoutMs?: number | undefined;
  /** 场景采样阈值（0–1，变化像素占比）。 */
  readonly sceneThreshold?: number | undefined;
  /** 视频帧输出格式。 */
  readonly videoFormat?: VideoFrameFormat | undefined;
  /** JPEG 质量（2–31，越小越清晰）。 */
  readonly jpegQuality?: number | undefined;
  /** 追加的二进制搜索目录（优先于 PATH）。 */
  readonly extraSearchPaths?: readonly string[] | undefined;
}
