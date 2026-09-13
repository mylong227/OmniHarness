import { OmniError, ErrorCode } from '../omniError.js';

/**
 * 模型调用错误（结构化，便于重试决策；#M6）。
 *
 * 从 `ports/model.ts` 迁出为独立模块（P1.3 端口纯化）：`src/ports/**` 只允许接口与纯类型，
 * 不得承载 `class` 实现。原路径 `ports/model.ts` 仍以 `export` 再导出本类，调用点零改动。
 */
export class ModelCallError extends OmniError {
  /** HTTP 状态码（网络层错误为 undefined）。 */
  public readonly status?: number | undefined;
  /** 是否可重试（429/408/5xx 通常可重试，4xx 客户端错误通常不可）。 */
  public readonly retryable: boolean;
  /** 服务端建议的等待毫秒数（Retry-After 头解析结果）。 */
  public readonly retryAfterMs?: number | undefined;

  /**
   * @param message 错误信息（透传给 `OmniError`）。
   * @param opts 结构化元数据：HTTP 状态码、是否可重试、建议等待毫秒数。
   */
  public constructor(
    message: string,
    opts: {
      readonly status?: number;
      readonly retryable: boolean;
      readonly retryAfterMs?: number | undefined;
    },
  ) {
    super(ErrorCode.MODEL_CALL_ERROR, message);
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
