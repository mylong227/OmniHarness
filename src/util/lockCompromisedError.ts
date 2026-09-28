// 「锁已被别人接管」：调用方**必须放弃这次写入**（不是重试，是别覆盖别人）。
//
// 单独成文件的原因：编码标准要求「文件名 = 主类名」，而它不是一个「锁实现」，而是一个**失败类型**，
// 由临界区里的 fencing 核对抛出，由调用方（`SessionSidecars.updateJson`）捕获并降级。
// 这条失败路径值得有名字：proper-lockfile 系列把「省掉 onCompromised」列为会把进程打死的已知坑
// （见 https://github.com/PrimeIntellect-ai/prime-agent/discussions/1556 ）。

/** 「锁已被别人接管」：调用方**必须放弃这次写入**（不是重试，是别覆盖别人）。 */
export class LockCompromisedError extends Error {
  /**
   * @param message 说明（含期望 token 与磁盘 token）
   */
  public constructor(message: string) {
    super(message);
    this.name = 'LockCompromisedError';
  }
}
