import type { SessionEvent } from '../../ports/event.js';
import type { EventPort } from '../../ports/eventPort.js';

/** 静默事件端口：丢弃事件（CLI 默认用，避免与结构化输出混流）。 */
export class SilentEventPort implements EventPort {
  readonly name = 'silent';

  /** 丢弃事件。 */
  emit(_event: SessionEvent): void {
    // 无操作
  }
}
