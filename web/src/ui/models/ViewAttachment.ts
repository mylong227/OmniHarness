// 视图挂载状态（**视图代数**）：判断"某个回合的收尾还属不属于当前视图"。
//
// ## 为什么需要它（2026-10-06 真机实测：用户报"新建会话无反应"）
//
// 回合进行中点「+ 新建」时，视图确实清空了，但**几秒后又被拽回来**：`ComposerController.send`
// 拿到 `res.threadId` 后无条件写回 `currentThreadId` 并 `navigate`，同时 SSE 仍在推该回合的
// `thread.event` / `thread.text_delta` / `thread.tool_input`——这三类事件**不带 threadId**，
// 客户端无从分辨是谁的，于是被用户放弃的回合把自己的视图"复活"了。
//
// 解法：把"视图挂在哪个回合上"变成可比较的**代数**——新建 / 切会话时 `detach()`（代数 +1），
// 发送前 `attach()` 记下代数，收尾与流式回调都用 `detached` / `epoch()` 判定"这还属于我吗"。
//
// 为什么单独成类（而不是往 SessionController 里加两个字段）：`SessionController` 本身已在
// 上帝类阈值上（26 方法），再加成员会被标准门禁拦下——本仓的惯例是**抽出去**而不是放宽阈值
// （与 `DeferredModes`、`StreamThrottle` 同处理）。
//
// 归属：实例由 `SessionController` 持有（`sessions.viewAttachment`），因为"摘 / 挂"两件事
// 都发生在那里（newSession 摘、loadThread 挂），同源才不会两处各改一半。
/**
 * 视图挂载状态（**视图代数**）：判断"某个回合的收尾还属不属于当前视图"。
 *
 * 默认**挂载**（`detached === false`）：全新控制器、刷新页面、深链加载会话都必须能继续接收
 * 该会话的流式事件——把默认值设成"已摘"会让这些正常路径静默丢事件（曾经的错法）。
 * 只有用户显式点「新建」（`SessionController.newSession`）才摘；加载某条会话（`loadThread`）
 * 会重新挂上。
 *
 * 用法：发送回合前 `attach()` 拿代数 → 收尾时比对 `epoch()`；流式回调只看 `detached`。
 */
export class ViewAttachment {
  /** 当前代数（每次 detach 自增）。 */
  private count = 0;

  /**
   * 视图是否已从某条会话上"摘下来"。
   *
   * 默认 `false`（挂载）：只有显式 `detach()`（点「新建」）才置位——避免把"刷新 / 深链加载会话"
   * 这类正常路径也变成丢事件。
   */
  private isDetached = false;

  /**
   * 当前视图代数。
   * @returns 代数序号（只增不减，仅用于相等比较）
   */
  public epoch(): number {
    return this.count;
  }

  /**
   * 视图是否已摘（摘了就不该再接收任何流式事件或回合收尾）。
   * @returns 已摘为 true；默认 false（挂载）
   */
  public get detached(): boolean {
    return this.isDetached;
  }

  /**
   * 把视图挂上（发送回合前 / 加载某条会话时调用），并**开新的一代**。
   *
   * 为什么每次挂载都让代数前进（而不是只在摘时前进）：换视图有两条路——点「新建」（会 detach）
   * 与**切到另一条会话**（loadThread，视图是挂载的，不会 detach）。后者若不动代数，旧回合收尾时
   * `epoch()` 仍等于旧值 ⇒ 旧会话的回复被写进新视图。让"每一次挂载"都成为新的一代，
   * 两条路就都收敛到同一条判据：`epoch() !== 我记下的代数` ⇒ 我已经不是当前视图了。
   * @returns 本次视图代数（收尾时与之比对）
   */
  public attach(): number {
    this.isDetached = false;
    this.count += 1;
    return this.count;
  }

  /**
   * 把视图摘下（新建会话时调用）：代数 +1，此后迟到的事件一律不进视图。
   * @returns 无
   */
  public detach(): void {
    this.count += 1;
    this.isDetached = true;
  }
}
