import type { SessionEvent } from '../../ports/event.js';
import type { EventPort } from '../../ports/eventPort.js';

/** 静默事件端口：丢弃事件（CLI 默认用，避免与结构化输出混流）。 */
export class SilentEventPort implements EventPort {
  /** 适配器名，与端口契约一致：固定为 'silent'。 */
  public readonly name = 'silent';

  /** 丢弃事件。 */
  public emit(_event: SessionEvent): void {
    // 无操作
  }
}
