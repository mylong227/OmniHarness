import type { FrameSelectionPolicy, MediaFrame, MediaKind, MediaProbeInfo } from './mediaTypes.js';

/** 帧提取请求。 */
export interface FrameExtractionRequest {
  /** 源文件**绝对路径**（越界校验由调用方在工具层完成）。 */
  readonly absolutePath: string;
  /** 已探测到的元数据（提取器可据此避免重复探测，也可在解码后回填更精确的值）。 */
  readonly probe: MediaProbeInfo;
  /** 采样与预算约束。 */
  readonly selection: FrameSelectionPolicy;
  /** 单次提取的总超时（毫秒）：到点即终止底层进程 / 解码。 */
  readonly timeoutMs: number;
  /** 会话取消信号（可选）：父会话取消时提取器应尽快收尾。 */
  readonly signal?: AbortSignal | undefined;
}

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
