import type { EtchNode } from './etchNode.js';

/** 一条已刻蚀的 trace（永久留存的分形刻痕）。 */
export interface EtchTrace {
  /** trace ID（== 事件 ID）。 */
  readonly id: string;
  /** 分形分支树根。 */
  readonly root: EtchNode;
  /** 创建时间（ISO）。 */
  readonly createdAt: string;
}
