import type { SessionEvent } from '../../ports/event.js';
import type { EventPort } from '../../ports/eventPort.js';

/** 静默事件端口：丢弃事件（CLI 默认用，避免与结构化输出混流）。 */
export class SilentEventPort implements EventPort {
  /** 适配器名，与端口契约一致：固定为 'silent'。 */
  public readonly name = 'silent';

  /** 丢弃事件。
   * @param _event 会话事件（本实现直接忽略，保留参数以符合端口签名）。
   */
  public emit(_event: SessionEvent): void {
    // 无操作
  }
}
