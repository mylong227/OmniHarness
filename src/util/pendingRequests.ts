/**
 * 在途请求表：**JSON-RPC 类协议的 pending / 超时 / id→Promise 关联的唯一实现**。
 *
 * ## 背景（为什么会有这个模块）
 *
 * 审计 §3.5 记「JSON-RPC pending/超时/id 关联重复 6 处且 `mcpClient.ts` 无 reject 通道」。
 * 具体缺陷（传输关闭时挂起请求永不被拒）已在 §20.18 单独修掉；剩下的**重复**才是本模块要收的口：
 * 实测七个站点各写一份几乎相同的簿记（登记 resolver/rejector + 超时定时器 + 命中后 delete/clearTimeout），
 * 差异只在细枝末节，于是「一处想到了清理定时器、另一处忘了」「一处有 reject 通道、另一处只有 resolve」
 * 这类**口径漂移**必然发生——而它的表征是最难查的「promise 永久挂起」。
 *
 * ## 各站点为什么不能共用一个「形状」
 *
 * 收款时必须保留语义差异，这些差异由**调用方**表达，而不是各自重写簿记：
 * - `reject` **可缺省**：`httpBridgeTransport` 只需成功路径（其 pending 表就是「谁来兑现这个响应」）；
 * - 超时**可缺省**：`serverEventBridge` 的审批等待上限可为 0（不限时）；
 * - 超时动作**由调用方决定**：`a2aClient`/`cdpClient`/`lspJsonRpcConnection`/`sdkClient`/`mcpClient`
 *   超时是 **reject**，而 `serverEventBridge` 超时是 **按 deny 兑现**（fail-closed 而非报错）——
 *   故 `onTimeout` 拿到的是处理器本体，由调用方选择 `resolve` 还是 `reject`，表本身不预设；
 * - 一次性收尾两种都有：`failAll`（连接断开 → 全部 reject）与 `settleAll`（断连 → 全部按同一值兑现，
 *   如审批一律 deny）。
 *
 * ## 不变量
 *
 * **任何被登记的处理器必然恰好在一条路径上被收尾**：命中（`take`/`settle`/`fail`）、超时、
 * 或一次性收尾（`failAll`/`settleAll`）。表在**移出条目的同时清掉定时器**，所以不存在
 * 「已兑现但定时器还在、稍后又 reject 一次」的双兑现（`onTimeout` 通过 `take` 的返回值判幂等）。
 * 唯一的例外由调用方造成且被显式记录：**同一 key 重复登记会覆盖旧条目**（见 {@link register}）。
 */

/** 一条在途请求的收尾通道；`reject` 缺省表示该站点只关心成功路径。 */
export interface PendingHandlers<T> {
  /** 兑现该请求。 */
  readonly resolve: (value: T) => void;
  /** 失败该请求（缺省时失败路径只做清理，不通知调用方）。 */
  readonly reject?: (error: Error) => void;
}

/**
 * 可选超时：到点后表**先移出条目并清定时器**，再把处理器交给 `onTimeout`，
 * 由调用方决定 reject（超时即错）或 resolve（如审批超时按 deny 兑现）。
 */
export interface PendingTimeout<T> {
  /** 超时毫秒数。 */
  readonly ms: number;
  /** 到点动作（此时条目已移出，回调内不必也不应再查表）。 */
  readonly onTimeout: (handlers: PendingHandlers<T>) => void;
}

/** 表内条目：处理器 + 超时句柄（无超时时缺省）。 */
interface PendingEntry<T> {
  readonly handlers: PendingHandlers<T>;
  readonly timer?: ReturnType<typeof setTimeout>;
}

/**
 * 在途请求表：key（JSON-RPC id / 审批 requestId）→ 收尾通道。
 *
 * @typeParam K 关联键（各站点用自增数字 id 或 `apr` 前缀字符串）。
 * @typeParam V 兑现值类型（响应消息 / result / 审批决策）。
 */
export class PendingRequests<K, V> {
  /** 在途条目（兑现、失败、超时、一次性收尾都会移出）。 */
  private readonly entries = new Map<K, PendingEntry<V>>();

  /**
   * 登记一条在途请求（**在发送请求之前**调用，避免回包早于登记）。
   *
   * 重复 key 会**覆盖**旧条目（与各站点原先 `Map.set` 的行为一致）：旧条目对应的 Promise
   * 由该站点自己的超时/断开路径收尾。七个站点都用单调 id（`nextId++` 或 `id('apr')`），
   * 正常不会发生；`httpBridgeTransport` 的 key 来自对端，故该情形由协议层负责。
   * @param key 关联键。
   * @param handlers 收尾通道（`reject` 可缺省）。
   * @param timeout 可选超时（缺省＝不设超时，如不限时的审批等待）。
   * @returns 无返回值。
   */
  public register(key: K, handlers: PendingHandlers<V>, timeout?: PendingTimeout<V>): void {
    // 覆盖旧条目前**先清掉它的超时定时器**：否则旧定时器到点时会 `onTimeout(key) → take(key)`，
    // 而 take 按 key 取到的是**新**条目 —— 于是新请求被旧超时配置提前 reject/收尾
    // （2026-09-26 审计 S28；本仓现有站点都用单调 id 故尚未触发，但模块文档宣称的
    // 「任何被登记的处理器必然恰好在一条路径上被收尾、绝不二次兑现」必须真的成立）。
    const previous = this.entries.get(key);
    if (previous?.timer !== undefined) {
      clearTimeout(previous.timer);
    }
    const entry: PendingEntry<V> =
      timeout === undefined
        ? { handlers }
        : { handlers, timer: setTimeout(() => this.onTimeout(key, timeout), timeout.ms) };
    this.entries.set(key, entry);
  }

  /**
   * 按 key **移出**条目并返回其收尾通道（同时清掉超时定时器）。
   *
   * 供「命中后还要自己判断 resolve 还是 reject」的站点使用（如按回包里的 `error` 字段分支）。
   * @param key 关联键。
   * @returns 收尾通道；未命中（已兑现 / 未知 id / 已超时）返回 undefined。
   */
  public take(key: K): PendingHandlers<V> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.clear(key, entry);
    return entry.handlers;
  }

  /**
   * 按 key 兑现（移出并 `resolve`）。
   * @param key 关联键。
   * @param value 兑现值。
   * @returns 命中并兑现返回 true；未命中返回 false（幂等，重复响应不会二次兑现）。
   */
  public settle(key: K, value: V): boolean {
    const handlers = this.take(key);
    if (handlers === undefined) {
      return false;
    }
    handlers.resolve(value);
    return true;
  }

  /**
   * 按 key 失败（移出并 `reject`；该站点无 reject 通道时只移出）。
   * @param key 关联键。
   * @param error 失败原因。
   * @returns 命中并处理返回 true；未命中返回 false。
   */
  public fail(key: K, error: Error): boolean {
    const handlers = this.take(key);
    if (handlers === undefined) {
      return false;
    }
    handlers.reject?.(error);
    return true;
  }

  /**
   * 一次性失败**全部**在途请求（传输/进程断开时调用），并清空表。
   *
   * 这是本模块最重要的用法：`Transport` 类契约没有关闭通知的站点必须显式调用它，
   * 否则在途请求只能各自等超时（`mcpClient` 的原始缺陷正是这一条）。
   * @param error 失败原因（各站点一句自己的话，便于归因）。
   * @returns 被收尾的条数（供日志与断言）。
   */
  public failAll(error: Error): number {
    const all = this.drain();
    for (const handlers of all) {
      handlers.reject?.(error);
    }
    return all.length;
  }

  /**
   * 一次性**兑现**全部在途请求为同一值（如审批断连时一律 deny），并清空表。
   * @param value 兑现值。
   * @returns 被兑现的条数。
   */
  public settleAll(value: V): number {
    const all = this.drain();
    for (const handlers of all) {
      handlers.resolve(value);
    }
    return all.length;
  }

  /**
   * 当前在途条数（观测 / 测试用）。
   * @returns 在途条数。
   */
  public size(): number {
    return this.entries.size;
  }

  /**
   * 超时到点：只有在条目仍存在时才收尾（已兑现则直接返回，保证幂等）。
   * @param key 关联键。
   * @param timeout 该条目的超时配置。
   * @returns 无返回值。
   */
  private onTimeout(key: K, timeout: PendingTimeout<V>): void {
    const handlers = this.take(key);
    if (handlers === undefined) {
      return;
    }
    timeout.onTimeout(handlers);
  }

  /**
   * 移出一条并清其定时器。
   * @param key 关联键。
   * @param entry 已取到的条目。
   * @returns 无返回值。
   */
  private clear(key: K, entry: PendingEntry<V>): void {
    this.entries.delete(key);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
  }

  /**
   * 移出全部条目（清定时器）并返回其收尾通道。
   * @returns 全部收尾通道（顺序为插入顺序）。
   */
  private drain(): PendingHandlers<V>[] {
    const all: PendingHandlers<V>[] = [];
    for (const [key, entry] of [...this.entries]) {
      this.clear(key, entry);
      all.push(entry.handlers);
    }
    return all;
  }
}
