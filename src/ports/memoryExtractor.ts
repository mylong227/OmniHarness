import type { SessionEvent } from './event.js';

/**
 * @beta
 * 长期记忆蒸馏器端口（#S28）。由 `TurnRunner` 在回合末调用，将自上次蒸馏以来的增量事件
 * 蒸馏为可跨会话复用的持久事实并沉淀进长期记忆。
 *
 * 具体实现见 `adapters/memory/memoryExtractor.ts` 的 `MemoryExtractor` 类。抽此端口使
 * `core`（runtime / turnRunner）与具体适配器解耦，实例由组合根 `config/` 装配注入。
 */
export interface MemoryExtractorPort {
  /** 蒸馏器标识。 */
  readonly name: string;
  /**
   * 回合末调用：把自上次蒸馏以来的新事件蒸馏为持久事实并沉淀。
   * 通过内部游标仅处理增量事件，避免每回合重复蒸馏整段历史。
   * @returns 本次新增事实数。
   */
  consolidate(events: readonly SessionEvent[], sessionId: string): Promise<number>;
}
