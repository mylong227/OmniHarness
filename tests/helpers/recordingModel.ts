import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';

/**
 * 记录型模型装饰器（测试专用）。
 *
 * 行为断言需要回答"模型此刻收到了什么"——这是**行为回归守卫**（G1a）与**前缀复用守卫**（G1b-b）
 * 共同的前提，故抽到 helpers 共用，避免两处各写一份而漂移。
 *
 * 注意：`messages` 做**浅拷贝**——请求对象在后续步骤里可能被就地追加，若直接存引用，
 * 事后读到的会是"最终态"而不是"当时发给模型的内容"。
 */
export class RecordingModel implements ModelPort {
  /** 端口名（与内层一致，避免影响按模型名分支的逻辑）。 */
  public readonly name: string;

  /** 按调用顺序记录的请求快照。 */
  public readonly requests: ModelRequest[] = [];

  /**
   * @param inner 被装饰的真实模型（通常是 `ScriptedModel`）。
   */
  public constructor(private readonly inner: ModelPort) {
    this.name = inner.name;
  }

  /**
   * 记录请求后转发给内层。
   * @param request 本次模型请求。
   * @returns 内层模型的产出。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.requests.push({ ...request, messages: [...request.messages] });
    return this.inner.generate(request);
  }

  /**
   * 把某次请求的消息序列化成可比对文本（前缀复用率的比对基准）。
   *
   * 与生产侧 `StepContextBuilder.measurePrefixReuse` 用同一口径（`JSON.stringify`），
   * 否则测试量到的复用率与线上日志不是一回事。
   * @param index 请求序号（0 起）。
   * @returns 序列化文本；序号越界时为 undefined。
   */
  public serialized(index: number): string | undefined {
    const request = this.requests[index];
    return request === undefined ? undefined : JSON.stringify(request.messages);
  }
}
