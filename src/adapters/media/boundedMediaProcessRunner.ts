import type {
  MediaProcessOutcome,
  MediaProcessRequest,
  MediaProcessRunner,
} from './mediaProcessRunner.js';

/** 缺省最大并发子进程数（单支媒体栈共享一个执行器，故这是「整支栈」的 ffmpeg 家族并发上限）。 */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * 有界并发的媒体子进程执行器（装饰器）。
 *
 * ## 为什么需要它（「可用就行」与「商用」的分界线）
 *
 * 裸 `SpawnMediaProcessRunner` 对并发**没有上限**：多层 agent 在同一次会话里并发调用
 * `view_media`（视频路径）时，会同时拉起任意多个 ffmpeg 进程——每个进程都要解码 + 抽帧，
 * 集体占满 CPU、内存与文件句柄，表象就是「宿主被抽帧拖垮 / 调度变慢 / 偶发 EMFILE」。
 * 这是多租户、多 agent 系统里典型的资源耗尽风险，标准商用做法是在执行层加一道
 * **并发闸**（token semaphore）：超过上限的请求排队，前面的进程退场后按 FIFO 补位。
 *
 * ## 为什么不把上限放进用户配置
 *
 * 这是**安全机制**而非调参旋钮：默认 4 已覆盖「几个工具调用并发」的常态，又不会放任
 * fork-bomb。需要更大并发属于部署调优，应在组合根显式覆盖，而不是让每个用户都能随手改大。
 *
 * ## 契约保真
 *
 * 对外仍是 `MediaProcessRunner`：入参、返回结构、超时 / 截断 / `spawnError` 语义**完全不变**，
 * 仅在「何时真正起进程」上加了一道闸。内层无论成功、超时还是 `spawnError` 都照常回传；
 * 若内层意外抛错（其契约本应保证不抛），本类也兜底成 `spawnError` 结果，**绝不把异常漏给调用方**
 * ——因为 `view_media` 的调用点没有为「执行器抛错」准备 catch（它依赖「永远返回 outcome」）。
 */
export class BoundedMediaProcessRunner implements MediaProcessRunner {
  /** 当前在跑的子进程数。 */
  private active = 0;

  /** 等待闸释放的待派发队列（FIFO）。 */
  private readonly pending: Array<() => void> = [];

  /**
   * @param inner 被装饰的内部执行器（通常即 `SpawnMediaProcessRunner`）。
   * @param maxConcurrent 最大并发子进程数（≥1；小于 1 按 1 处理）。
   */
  public constructor(
    private readonly inner: MediaProcessRunner,
    maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  ) {
    this.limit = Math.max(1, Math.floor(maxConcurrent));
  }

  /** 最大并发数（构造时收敛）。 */
  private readonly limit: number;

  /**
   * 在并发闸约束下执行一条命令（超出发起排队，前面退场后补位）。
   *
   * @param request 执行请求。
   * @returns 单次执行结果（不抛异常）。
   */
  public run(request: MediaProcessRequest): Promise<MediaProcessOutcome> {
    return new Promise<MediaProcessOutcome>((resolve) => {
      const dispatch = (): void => {
        this.active += 1;
        Promise.resolve()
          .then(() => this.inner.run(request))
          .then(
            (outcome) => {
              this.release();
              resolve(outcome);
            },
            (error: unknown) => {
              // 内层契约本应「永不抛」，但仍兜底：异常一律转为 spawnError 结果，
              // 否则未捕获的 reject 会穿透 `view_media` 的调用点（那里没有为「执行器抛错」写 catch）。
              this.release();
              resolve(BoundedMediaProcessRunner.asSpawnError(error));
            },
          );
      };
      if (this.active < this.limit) {
        dispatch();
      } else {
        this.pending.push(dispatch);
      }
    });
  }

  /**
   * 释放一个并发槽并尽量补位。
   *
   * @returns 无返回值。
   */
  private release(): void {
    this.active -= 1;
    const next = this.pending.shift();
    if (next !== undefined) {
      next();
    }
  }

  /**
   * 把意外错误转成「启动失败」结果（兜底，保持 `MediaProcessRunner` 不抛的契约）。
   *
   * @param error 捕获到的错误。
   * @returns 等价的结果对象。
   */
  private static asSpawnError(error: unknown): MediaProcessOutcome {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: null,
      stdout: Buffer.alloc(0),
      stderr: '',
      timedOut: false,
      truncated: false,
      spawnError: `媒体执行器内部错误：${message}`,
    };
  }
}
