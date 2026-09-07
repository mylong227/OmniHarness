import type { SessionEvent } from '../ports/event.js';
import type { EventPort } from '../ports/eventPort.js';

/**
 * @beta
 * 子会话事件桥：内部收集轨迹，不向父观测流广播。
 *
 * 子智能体一次运行可能产生数十条事件，逐条灌进父事件流会淹没主会话且污染上下文；
 * 改为内部收集后随结果一并返回，既保留完整审计轨迹，又保持主会话清爽。
 */
export class SubagentEventBridge implements EventPort {
  readonly name = 'subagent-bridge';

  private readonly collected: SessionEvent[] = [];

  /** 收集事件（不转发）。 */
  emit(event: SessionEvent): void {
    this.collected.push(event);
  }

  /** 收集到的全部事件。 */
  events(): readonly SessionEvent[] {
    return [...this.collected];
  }

  /** 事件条数（观测用）。 */
  size(): number {
    return this.collected.length;
  }
}
