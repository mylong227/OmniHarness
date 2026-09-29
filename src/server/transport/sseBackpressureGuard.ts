import type { ServerResponse } from 'node:http';

/**
 * SSE 客户端背压守卫：跟踪每个慢客户端连续 `write` 失败的次数，
 * 超阈值即判定该客户端应被丢弃（fail-closed 偏严，宁可少推一个慢连接也不拖垮服务端事件总线）。
 *
 * 从 {@link HttpBridgeTransport} 抽离，使「背压计数」这一单一职责独立、可单测。
 */
export class SseBackpressureGuard {
  /** 连续写失败达此次数即丢弃该客户端。 */
  private static readonly MAX_CONSECUTIVE_STALLS = 64;

  /** 每客户端连续写失败计数（写成功或断开即清零）。 */
  private readonly stalls = new Map<ServerResponse, number>();

  /**
   * 记一次写失败；返回 true 表示连续背压已超阈值，调用方应丢弃该客户端。
   * @param client 写失败的 SSE 客户端。
   * @returns 是否应丢弃该客户端（连续背压超阈值）。
   */
  public hit(client: ServerResponse): boolean {
    const next = (this.stalls.get(client) ?? 0) + 1;
    if (next > SseBackpressureGuard.MAX_CONSECUTIVE_STALLS) {
      this.stalls.delete(client);
      return true;
    }
    this.stalls.set(client, next);
    return false;
  }

  /**
   * 写成功：清零该客户端的背压计数。
   * @param client 写成功的 SSE 客户端。
   * @returns 无返回值。
   */
  public clear(client: ServerResponse): void {
    this.stalls.delete(client);
  }

  /**
   * 客户端断开/移除：清理其背压计数。
   * @param client 已断开的 SSE 客户端。
   * @returns 无返回值。
   */
  public remove(client: ServerResponse): void {
    this.stalls.delete(client);
  }
}
