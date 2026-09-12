/**
 * 检查点管理器端口（P1 解耦）。
 *
 * 原 `CheckpointManager`（core）被 `adapters/tool/checkpointTool`、`rollbackTool` 以
 * `import type` 引用，构成 adapters→core 违规（门禁按导入路径计边，type-only 亦计）。
 * 抽出端口后适配器仅依赖此接口类型，实例由组合根注入；core 的实现类 `implements` 本接口。
 */

/** 检查点元信息。 */
export interface CheckpointMeta {
  readonly label: string;
  readonly ts: string;
  readonly eventCount: number;
  /** 是否包含文件级快照（可用于代码回滚）。 */
  readonly hasFileSnapshot: boolean;
}

/** 检查点管理器端口：打快照 / 回滚到指定或最近检查点。 */
export interface CheckpointManagerPort {
  /** 为当前 session 打快照；返回 meta。已存在同 label 则覆盖。 */
  snapshot(sessionId: string, label: string): Promise<CheckpointMeta>;
  /**
   * 回滚到选中快照：把其 events 覆盖写回主 session storage（"回到该点"）。
   * 不传 label 时回滚到最近一次快照；指定 label 不存在 fail-closed 抛错。
   */
  rollback(sessionId: string, label?: string): Promise<CheckpointMeta>;
}
