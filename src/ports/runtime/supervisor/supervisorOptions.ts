import type { AuditSinkLike } from './auditSinkLike.js';

/** 监督内核选项（全部带默认值，零配置可用）。 */
export interface SupervisorOptions {
  /** 滑动窗口大小（默认 32）：仅最近 N 次执行计入健康分。 */
  readonly windowSize?: number;
  /** 失败率阈值，超过即 degraded（默认 0.25）。 */
  readonly degradeThreshold?: number;
  /** 失败率阈值，超过即 safe（默认 0.5）。 */
  readonly safeThreshold?: number;
  /** 连续失败累计达此值即 locked（默认 5）。 */
  readonly lockAfterConsecutiveFailures?: number;
  /** 危险工具名（进入 safe/locked 后一律拒绝）。可传数组或集合。 */
  readonly hazardousTools?: ReadonlySet<string> | ReadonlyArray<string>;
  /** 审计 sink（可选）：模式切换时把健康快照写入哈希链。 */
  readonly audit?: AuditSinkLike;
  /** 会话标识（写入审计 detail 用）。 */
  readonly sessionId?: string;
}
