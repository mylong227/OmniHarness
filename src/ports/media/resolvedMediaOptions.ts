import type { VideoFrameFormat } from './mediaTypes/videoFrameFormat.js';

/** 解析后的媒体选项（全部字段有值，可直接消费）。 */
export interface ResolvedMediaOptions {
  /** ffmpeg 路径（显式配置；`undefined` 时由定位器自动查找）。 */
  readonly ffmpegPath: string | undefined;
  /** ffprobe 路径（显式配置）。 */
  readonly ffprobePath: string | undefined;
  /** 单次交付的帧数上限（已收敛到允许区间）。 */
  readonly maxFrames: number;
  /** 单帧长边上限（像素）。 */
  readonly maxDimension: number;
  /** 单帧字节上限。 */
  readonly maxFrameBytes: number;
  /** 单次交付的总字节上限。 */
  readonly maxTotalBytes: number;
  /** 源文件体积上限。 */
  readonly maxInputBytes: number;
  /** 单次提取超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 场景采样阈值（0–1）。 */
  readonly sceneThreshold: number;
  /** 视频帧输出格式。 */
  readonly videoFormat: VideoFrameFormat;
  /** JPEG 质量。 */
  readonly jpegQuality: number;
  /** 追加的二进制搜索目录。 */
  readonly extraSearchPaths: readonly string[];
  /** 环境变量表（供二进制定位器读取 `OMNI_FFMPEG_PATH` 等）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
}
