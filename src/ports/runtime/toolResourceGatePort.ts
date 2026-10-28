/**
 * 工具级资源域闸端口（2026-10-28，BLOCKERS §5：给工具声明资源域与锁语义）。
 *
 * 解决的真实争抢：`BrowserSession` 跨调用复用同一浏览器——两个会话并发调
 * `browser_act` / `browser_screenshot` 会互踩同一标签页（A navigate 与 B screenshot
 * 交错 ⇒ B 截到 A 的页面）。技能激活层的 `exclusive` 只管同会话同回合的规划，
 * 跨**会话**的工具级争抢由本闸管。实现见 `core/toolResourceGate.ts`；
 * 声明表（工具 → 域）见 `ports/tool/toolResourceDomains.ts`（单一来源）。
 */

/** 资源域闸观测快照。 */
export interface ToolResourceGateStats {
  /** 有状态的域数量。 */
  readonly keys: number;
  /** 正在持有的读锁总数。 */
  readonly readers: number;
  /** 正在持有的写锁总数（每域 0/1，跨域求和）。 */
  readonly writers: number;
  /** 排队等待者总数。 */
  readonly waiters: number;
}

/** 资源域闸端口（组合根持有进程级单例，全会话共享锁表）。 */
export interface ToolResourceGatePort {
  /** 适配器标识。 */
  readonly name: string;
  /**
   * 按工具声明的资源域获取锁（多域按名字典序获取，防 ABBA 死锁）。
   * @param toolName 工具名。
   * @param sessionId 发起会话（观测归因用；互斥是跨会话的）。
   * @param signal 会话取消信号（等待期生效）。
   * @returns 幂等释放函数；无可声明域或闸关闭时为空释放函数。
   * @throws LockError 等待被取消时拒绝。
   */
  acquire(
    toolName: string,
    sessionId: string,
    signal?: AbortSignal | undefined,
  ): Promise<() => void>;
  /**
   * 观测快照（诊断用；不改变状态）。
   * @returns 锁表计数。
   */
  stats(): ToolResourceGateStats;
}
