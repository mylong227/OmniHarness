import type { ServerResponse } from 'node:http';
import type { RpcMessage } from '../core/jsonRpc.ts';
import { SseBackpressureGuard } from './sseBackpressureGuard.ts';

/** 重放历史帧上限（条数）：覆盖一次短暂断网即可。 */
const SSE_HISTORY_MAX = 256;

/**
 * 重放历史字节上限（缺省 8 MiB）。
 *
 * 为什么条数上限不够：`thread.event` 帧里可能带 `tool_result.files[].data`（截图 base64，
 * 单张上限 5 MiB）。256 条 × 6.7 MiB 的理论上限是 ~1.7 GB；只按条数限制等于没有内存上限。
 * 超限帧（单帧就大于预算）不进入重放历史，但照常广播给在线客户端。
 */
const SSE_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

/** SSE 扇出回调。 */
export interface SseFanoutHooks {
  /** 首个客户端接入（用于「曾有过客户端」的跃迁判断）。 */
  readonly onClientAdded: () => void;
  /** 客户端集合从非空变为空（用于把挂起审批按 deny 收尾）。 */
  readonly onClientsGone: () => void;
}

/** SSE 扇出选项（可选；缺省与历史行为一致，只多一个字节上限）。 */
export interface SseFanoutOptions {
  /** 重放历史最大帧数（缺省 256）。 */
  readonly maxHistoryFrames?: number;
  /** 重放历史最大字节数（缺省 8 MiB）。 */
  readonly maxHistoryBytes?: number;
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
  private readonly history: { seq: number; frame: string; bytes: number }[] = [];
  /** 历史帧累计字节数（与 `history` 同增同减）。 */
  private historyBytes = 0;
  /** 最大历史帧数。 */
  private readonly maxHistoryFrames: number;
  /** 最大历史字节数。 */
  private readonly maxHistoryBytes: number;

  /**
   * @param hooks 客户端增减回调。
   * @param options 历史条数/字节上限（可缺省）。
   */
  public constructor(
    private readonly hooks: SseFanoutHooks,
    options: SseFanoutOptions = {},
  ) {
    this.maxHistoryFrames = SseFanout.positiveOr(options.maxHistoryFrames, SSE_HISTORY_MAX);
    this.maxHistoryBytes = SseFanout.positiveOr(options.maxHistoryBytes, SSE_HISTORY_MAX_BYTES);
  }

  /**
   * 当前连接数（宿主判断「全部断开」用）。
   * @returns 当前 SSE 连接数。
   */
  public count(): number {
    return this.clients.size;
  }

  /** 当前重放历史的帧数与字节数（观测/判据用）。
   * @returns `{ frames, bytes }`。
   */
  public historyStats(): { readonly frames: number; readonly bytes: number } {
    return { frames: this.history.length, bytes: this.historyBytes };
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
      this.remember(seq, frame);
    }
    for (const client of this.clients) {
      this.write(client, frame);
    }
  }

  /**
   * 写入一条重放历史，并按条数/字节双上限淘汰最旧。
   *
   * 单帧就超过总预算时不入历史（否则「一条大图帧」会让上限形同虚设）；该帧仍会广播给
   * 在线客户端，只是断线重连拿不到它——这是内存安全优先的取舍。
   * @param seq 全局序号。
   * @param frame 已格式化帧。
   * @returns 无返回值。
   */
  private remember(seq: number, frame: string): void {
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > this.maxHistoryBytes) {
      return;
    }
    this.history.push({ seq, frame, bytes });
    this.historyBytes += bytes;
    while (
      this.history.length > this.maxHistoryFrames ||
      (this.historyBytes > this.maxHistoryBytes && this.history.length > 1)
    ) {
      const dropped = this.history.shift();
      if (dropped === undefined) break;
      this.historyBytes -= dropped.bytes;
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

  /** 归一化正数选项（非法/非正回落默认）。
   * @param value 输入值。
   * @param fallback 默认值。
   * @returns 正数。
   */
  private static positiveOr(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  }
}
