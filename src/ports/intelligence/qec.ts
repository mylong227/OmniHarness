/**
 * QEC 式可校验记忆端口（I-P1-3）。S+ 发明层。
 *
 * 把长期记忆建成"稳定子+症状（syndrome）"编码块：用二维奇偶症状（行/列 XOR）编码每条事实，
 * 只读症状即可**定位单点 corrupt 并纠正**（阈值定理风味），直击灾难性遗忘；多点 corrupt
 * 无法定位则标记 uncorrectable（fail-closed，绝不静默接受损坏内容）。向量库/副本式记忆在
 * 代数上无此"可校验纠错"维度（市面唯一）。
 */
export type QECStatus = 'ok' | 'corrected' | 'uncorrectable';

/** 全量校验+纠正报告。 */
export interface QECReport {
  /** 校验的事实数。 */
  readonly checked: number;
  /** 被定位并纠正的数。 */
  readonly corrected: number;
  /** 无法纠正（多点 corrupt）的数。 */
  readonly uncorrectable: number;
}

/** QEC 编码器端口。 */
export interface QECEncoderPort {
  readonly name: string;
  /** 为已写入的事实（重）编码：写入/刷新其二维奇偶症状。 */
  encode(id: string): void;
  /** 校验单条：ok / 可纠正(corrected) / 不可纠正(uncorrectable)。不擅自改写。 */
  verify(id: string): QECStatus;
  /** 纠正单条：仅当可纠正时写回修复，否则返回原状态（fail-closed）。 */
  repair(id: string): QECStatus;
  /** 全量校验+纠正：返回报告。 */
  repairAll(): QECReport;
}
