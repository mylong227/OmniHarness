// 面向对象的服务层：封装 GET /events 的 SSE 长连接。以回调（而非全局事件）对外暴露，
// 由 App 统一路由到对应的状态更新，避免 vanilla 版散落的隐式耦合。

import type { SseEnvelope } from '../types/models.js';

export class EventStream {
  private es: EventSource | null = null;
  public onMessage: ((msg: SseEnvelope) => void) | null = null;
  public onOpen: (() => void) | null = null;
  public onClose: (() => void) | null = null;

  public connect(): void {
    if (this.es) return;
    const es = new EventSource('/events');
    es.onopen = () => this.onOpen?.();
    es.onerror = () => this.onClose?.();
    es.onmessage = (e: MessageEvent) => {
      let msg: SseEnvelope;
      try {
        msg = JSON.parse(e.data as string) as SseEnvelope;
      } catch {
        return;
      }
      this.onMessage?.(msg);
    };
    this.es = es;
  }

  /** EventSource.OPEN === 1；用于判断 SSE 是否连通以决定 graph 运行是否回退轮询。 */
  public get isOpen(): boolean {
    return this.es ? this.es.readyState === 1 : false;
  }

  public close(): void {
    if (this.es) this.es.close();
    this.es = null;
  }
}
