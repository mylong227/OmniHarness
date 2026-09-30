import type { FrameExtractionRequest } from './frameExtractionRequest.js';
import type { FrameExtractionResult } from './frameExtractionResult.js';
import type { MediaKind } from '../mediaTypes.js';

/**
 * 帧提取器端口：把「一个媒体源」变成「若干张带时间戳的帧」。
 *
 * 实现按能力分流（`supports`），由 `RoutingFrameExtractor` 在组合根按 `kind` 选择：
 * - 动画 GIF → 纯 TS 解码（零外部二进制，任何机器可用）；
 * - 视频 → 本机 ffmpeg（探测不到即 fail-closed，并给出可行动的安装/配置指引）。
 */
export interface MediaFrameExtractor {
  /** 实现名（用于诊断与错误文案）。 */
  readonly name: string;
  /**
   * 是否支持该媒体大类。
   *
   * @param kind 媒体大类。
   * @returns 支持时为 true。
   */
  supports(kind: MediaKind): boolean;
  /**
   * 执行提取。
   *
   * 契约：**不静默**——无法提取时以 `ok:false` + 可行动原因结束（调用方转成工具错误），
   * 部分成功时在 `notes` 里逐条说明丢掉了什么。
   *
   * @param request 提取请求。
   * @returns 提取结果（帧集合 + 精确元数据 + 说明）。
   */
  extract(request: FrameExtractionRequest): Promise<FrameExtractionResult>;
}
