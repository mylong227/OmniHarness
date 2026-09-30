import type { EtchEvent } from './etchEvent.js';
import type { EtchTrace } from './etchTrace.js';
import type { EtchConduction } from './etchConduction.js';

/** 刻蚀记忆端口。 */
export interface InsightEtchingPort {
  readonly name: string;
  /**
   * 刻蚀一次顿悟事件：在记忆介质上刻出分形分支决策树。
   * fail-closed：空 ID / 空标签的事件抛错。
   */
  etch(event: EtchEvent): EtchTrace;
  /**
   * 沿与 query 共振最强的刻痕低阻导通，返回 top-k 分支路径。
   * 无任何 trace 共振 ≥ 阈值时返回 []（沿痕不通，正常回落检索）。
   */
  conduct(query: string, k?: number): readonly EtchConduction[];
  /** 已刻蚀 trace 数。 */
  readonly traces: number;
}
