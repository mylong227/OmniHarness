/** 长期记忆事实的可变字段补丁（管理 UI 编辑时使用）。 */
export type MemoryFactPatch = Partial<{
  text: string;
  topic: string | undefined;
  importance: number;
  /** 失效时间（ISO，可选）：设为过去时间即可令该事实在 recall 中失效。 */
  expiresAt: string | undefined;
}>;
