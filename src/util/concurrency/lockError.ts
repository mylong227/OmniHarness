/**
 * 并发原语的统一失败类型。
 *
 * 为什么不让每个原语各抛一种 Error：调用方（工具层）必须把「等锁超时」「被取消」「队列满」
 * 翻译成**对模型可行动**的文案，而 `instanceof` 分散在多个文件里最容易在重构时漏掉一条分支。
 * 单类 + 判别式 `code` 让「该重试 / 该放弃 / 该换文件」在同一处裁决。
 */
export class LockError extends Error {
  /** 失败类别（重试语义由它决定）。 */
  public readonly code: 'busy' | 'aborted' | 'timeout' | 'queue-full' | 'unavailable';

  /**
   * @param code 失败类别（重试语义由它决定：`busy` 可重试、`aborted` 应停、`queue-full` 应降低并发）。
   * @param message 可读原因（会原样进入工具错误/日志）。
   */
  public constructor(
    code: 'busy' | 'aborted' | 'timeout' | 'queue-full' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'LockError';
  }
}
