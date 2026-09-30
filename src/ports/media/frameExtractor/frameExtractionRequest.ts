import type { FrameSelectionPolicy, MediaProbeInfo } from '../mediaTypes.js';

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
