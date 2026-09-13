import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  StreamCallbacks,
} from '../../ports/model/model.js';
import type { CircuitBreaker } from '../../util/circuitBreaker.js';

/**
 * 模型调用熔断装饰器（F3）：把任意 `ModelPort` 包一层三态熔断。
 *
 * 与 {@link RetryingModel} 的**组合顺序约定**（装配点必须遵守）：
 * 本装饰器应包在 `RetryingModel` 的**外层**，即 `CircuitBreakingModel(RetryingModel(inner))`。
 * 这样一次逻辑调用（含其内部全部重试）才计为一次熔断计数——重试负责吸收单次调用的瞬时抖动，
 * 熔断负责识别"跨调用的持续不可用"，二者职责不混叠。
 *
 * 开路期间：`generate`/`stream` 立即抛 `CircuitOpenError`，**不发起任何网络调用**（fail-closed），
 * 冷却到期后由熔断器自动半开放行探测。对上层完全透明（`name` 透传、`stream` 存在性与内部一致）。
 */
export class CircuitBreakingModel implements ModelPort {
  /** 适配器名（端口契约），透传内部模型的 name，对上层完全透明。 */
  public readonly name: string;

  /**
   * 流式生成：仅当内部模型真的具备 `stream` 能力时才定义（与 RetryingModel 同约定）。
   * 对无 `stream` 的内部模型（如 mock）不虚假广告，避免上层拿到 undefined 后崩溃。
   */
  public readonly stream?: (
    request: ModelRequest,
    callbacks: StreamCallbacks,
  ) => Promise<ModelOutput>;

  /**
   * @param inner 被装饰的底层模型端口（熔断裁决通过后才执行）。
   * @param breaker 熔断器实例（须跨调用长期存活；由组合根装配一次）。
   */
  public constructor(
    private readonly inner: ModelPort,
    private readonly breaker: CircuitBreaker,
  ) {
    this.name = inner.name;
    if (inner.stream !== undefined) {
      const innerStream = inner.stream.bind(inner);
      this.stream = (request, callbacks) =>
        this.breaker.execute(() => innerStream(request, callbacks));
    }
  }

  /** 生成响应（受熔断保护）。
   * @param request 模型请求（原样透传给内部模型）。
   * @returns 内部模型的输出；熔断开路时抛 `CircuitOpenError`。
   */
  public generate(request: ModelRequest): Promise<ModelOutput> {
    return this.breaker.execute(() => this.inner.generate(request));
  }
}
