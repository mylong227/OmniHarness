import type { SessionEvent } from './event.js';

/** 事件端口：观测/审计/轨迹系统的统一插口。 */
export interface EventPort {
  readonly name: string;
  emit(event: SessionEvent): void;
}
