import type { MediaProbeInfo } from './mediaTypes.js';

/**
 * 媒体探测端口：只读元数据，不解码像素。
 *
 * 为什么探测与提取分离：模型决定「要不要逐帧看」之前，需要先知道这是什么东西
 * （3 秒 GIF 还是 40 分钟录像、多少帧、多大），而探测的成本必须远低于提取。
 * GIF 走纯 TS 头解析；视频走本机 `ffprobe`（与提取共用同一个二进制定位器）。
 */
export interface MediaProbePort {
  /** 实现名（用于诊断与错误文案）。 */
  readonly name: string;
  /**
   * 探测元数据。
   *
   * @param absolutePath 源文件绝对路径。
   * @param signal 会话取消信号（可选）。
   * @returns 元数据；无法探测时返回 `undefined`（调用方决定是降级还是拒绝）。
   */
  probe(absolutePath: string, signal?: AbortSignal): Promise<MediaProbeInfo | undefined>;
}
