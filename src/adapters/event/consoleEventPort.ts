import type { SessionEvent } from '../../ports/event.js';
import type { EventPort } from '../../ports/eventPort.js';

/** 控制台事件端口：事件流向 stdout（观测/调试）。 */
export class ConsoleEventPort implements EventPort {
  public readonly name = 'console';

  /** 输出事件。 */
  public emit(event: SessionEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
