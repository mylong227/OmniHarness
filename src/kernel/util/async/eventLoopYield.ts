/**
 * 事件循环让出工具（G8，2026-10-03）。
 *
 * ## 为什么需要它
 *
 * 本仓有若干**纯 CPU 的分块循环**（逐文件读盘 + 哈希 + 解析建语料等）。实测
 * `ContextEngine.indexCorpus` 在 `src/`（919 文件）上单次耗时约 **1.4 s**，全部在**同步**段里跑完：
 * 这段时间里定时器、HTTP 请求回调、日志 flush、Web GUI 的心跳**一个都跑不了**
 * （`monitorEventLoopDelay().max` 会直接飙到 1.4 s 量级）。用户可感知后果：首回合/语料变更后，
 * 服务端界面与取消响应都会"卡住一下"。
 *
 * ## 口径（为什么用 `setImmediate` 而不是 `await Promise.resolve()`）
 *
 * `await Promise.resolve()` 只让出**微任务**队列，**不会**让 I/O 与定时器得到机会——那是"看起来让了、
 * 实际没让"。要让事件循环真正跑一轮 I/O + timers，必须交回**宏任务**阶段，故用 `setImmediate`
 * （Node 文档明确其为"在当前轮 I/O 事件之后执行"，适合把长任务切片）。
 *
 * ## 与"让出"无关的既有担忧
 *
 * 切片**不改变结果**，只改变执行时序：调用方必须保证切片之间没有其它写者改同一份输入
 * （本仓的语料构建是只读快照，满足）。切片粒度由调用方给定，`DEFAULT_CHUNK` 取 32——
 * 以 919 文件 / 1.4 s 计，单块约 50 ms，远低于"感知卡顿"阈值。
 */
export class EventLoopYield {
  /** 默认分块粒度（文件数）：以本仓实测 ~1.5 ms/文件计，32 个文件 ≈ 50 ms 一块。 */
  public static readonly DEFAULT_CHUNK = 32;

  /**
   * 让出一次事件循环（交回宏任务阶段，使 I/O 与定时器得以运行）。
   * @returns 让出完成后 resolve。
   */
  public static async turn(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
