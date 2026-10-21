import type { ServerResponse } from 'node:http';
import type { RpcMessage } from '../core/jsonRpc.ts';
import { SseBackpressureGuard } from './sseBackpressureGuard.ts';

/** 重放历史帧上限（按单帧几十 KB 估算约数 MB，覆盖一次短暂断网即可）。 */
const SSE_HISTORY_MAX = 256;

/** SSE 扇出回调。 */
export interface SseFanoutHooks {
  /** 首个客户端接入（用于「曾有过客户端」的跃迁判断）。 */
  readonly onClientAdded: () => void;
  /** 客户端集合从非空变为空（用于把挂起审批按 deny 收尾）。 */
  readonly onClientsGone: () => void;
}

/**
 * SSE 客户端扇出器（2026-10-21 从 `HttpBridgeTransport` 拆出）。
 *
 * 职责：维护 SSE 连接集合、背压淘汰、`thread.event` 的全局序号与断线重放。
 * 抽出的机械原因：`HttpBridgeTransport` 的属性/方法数已贴着「上帝类」门禁，
 * 而重连重放又必须新增状态；把这块内聚逻辑独立成类，宿主只保留一行 `sse.broadcast(...)`。
 */
export class SseFanout {
  /** 当前 SSE 连接。 */
  private readonly clients = new Set<ServerResponse>();
  /** 慢客户端背压守卫。 */
  private readonly guard = new SseBackpressureGuard();
  /** 已分配的全局序号（仅 `thread.event` 使用）。 */
  private seq = 0;
  /** `thread.event` 的环形历史（seq + 已格式化帧）。 */
  private readonly history: { seq: number; frame: string }[] = [];

  /**
   * @param hooks 客户端增减回调（宿主据此维护「全部断开」判断）。
   */
  public constructor(private readonly hooks: SseFanoutHooks) {}

  /**
   * 当前连接数（宿主判断「全部断开」用）。
   * @returns 当前 SSE 连接数。
   */
  public count(): number {
    return this.clients.size;
  }

  /**
   * 注册客户端；带 `lastEventId` 时先重放该序号之后的会话事件。
   * @param response event-stream 响应对象。
   * @param lastEventId 客户端重连携带的 `Last-Event-ID`（可缺省）。
   * @returns 无返回值。
   */
  public register(response: ServerResponse, lastEventId?: number): void {
    this.clients.add(response);
    this.hooks.onClientAdded();
    response.on('close', () => {
      this.clients.delete(response);
      this.guard.remove(response);
      this.hooks.onClientsGone();
    });
    if (lastEventId === undefined) {
      return;
    }
    for (const entry of this.history) {
      if (entry.seq > lastEventId) {
        this.write(response, entry.frame);
      }
    }
  }

  /**
   * 广播一条通知给全部 SSE 客户端；`thread.event` 会分配 `id:` 并记入重放历史。
   * @param message 通知消息。
   * @returns 无返回值。
   */
  public broadcast(message: RpcMessage): void {
    const isThreadEvent =
      'method' in message && (message as { method?: string }).method === 'thread.event';
    let frame = `data: ${JSON.stringify(message)}\n\n`;
    if (isThreadEvent) {
      // 一条流混合多个会话，重放水位用**全局序号**才不会漏掉别的会话在断线窗口内的事件。
      const seq = (this.seq += 1);
      frame = `id: ${seq}\ndata: ${JSON.stringify(message)}\n\n`;
      this.history.push({ seq, frame });
      if (this.history.length > SSE_HISTORY_MAX) {
        this.history.shift();
      }
    }
    for (const client of this.clients) {
      this.write(client, frame);
    }
  }

  /**
   * 向单个客户端写一帧（含背压淘汰）。
   * @param client SSE 响应对象。
   * @param frame 已格式化帧。
   * @returns 无返回值。
   */
  private write(client: ServerResponse, frame: string): void {
    if (client.write(frame)) {
      this.guard.clear(client);
      return;
    }
    if (!this.guard.hit(client)) {
      return;
    }
    this.clients.delete(client);
    try {
      client.end();
    } catch {
      // 已断开：忽略
    }
    this.hooks.onClientsGone();
  }
}
