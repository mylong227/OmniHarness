import type { SessionEvent } from './event.js';

/** 事件端口：观测/审计/轨迹系统的统一插口。 */
export interface EventPort {
  readonly name: string;
  emit(event: SessionEvent): void;
  /**
   * 可选：冲刷端口内部缓冲（如 OTLP span 批量外发）。
   *
   * 为什么是可选的：多数端口（console / silent / 桥接）本就无缓冲，实现它是噪音；
   * 有缓冲的端口（{@link TraceCollectingEventPort}）实现它后，`Agent.runTask` 的 finally
   * 会在回合收尾时调用一次，保证「进程结束前的最后一批 span 不丢」。
   *
   * @returns 冲刷完成（无论成败）的 Promise；未实现表示无缓冲。
   */
  flush?(): Promise<void>;
}
