/** 长期记忆事实的可变字段补丁（管理 UI 编辑时使用）。 */
export type MemoryFactPatch = Partial<{
  text: string;
  topic: string | undefined;
  importance: number;
  /** 失效时间（ISO，可选）：设为过去时间即可令该事实在 recall 中失效。 */
  expiresAt: string | undefined;
  /** 上次被召回时间（ISO，可选；间隔重复强化写回，`OMNI_MEMORY_FORGETTING=1`）。 */
  lastRecallAt: string | undefined;
  /** 累计召回次数（可选；间隔重复强化记账）。 */
  recallCount: number | undefined;
  /** 记忆稳定度（天，可选；间隔重复强化写回）。 */
  stabilityDays: number | undefined;
}>;
