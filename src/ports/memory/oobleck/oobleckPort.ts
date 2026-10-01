import type { OobleckRecord } from './oobleckRecord.js';
import type { OobleckWriteResult } from './oobleckWriteResult.js';

/** 非牛顿固化存储端口：提交由冲击涌现，冻结后不可变。 */
export interface OobleckPort {
  readonly name: string;

  /**
   * 以给定冲击幅度 `impact` 提议写入 `value`。
   * - `impact >= yieldStress`：剪切增稠，提交并**冻结**（emergent，非显式调用）。
   * - `impact < yieldStress` 且未冻结：液态覆盖，状态松弛。
   * - 已冻结：拒绝（fail-closed）。
   */
  propose(key: string, value: string, impact: number): Promise<OobleckWriteResult>;

  /** 读取记录（含冻结态）。 */
  get(key: string): Promise<OobleckRecord | undefined>;

  /** 是否已冻结。 */
  isFrozen(key: string): Promise<boolean>;

  /** 删除：液态下允许；冻结后拒绝（不可变）。 */
  delete(key: string): Promise<boolean>;

  /** 关闭底层资源。 */
  close(): Promise<void>;
}
