/** 一条便签（交接物）。 */
export interface ScratchpadNote {
  /** 稳定 id（写入时生成，单调）。 */
  readonly id: string;
  /** 写入时刻（ISO 8601）。 */
  readonly at: string;
  /** 便签正文：任务状态 + 下一步 + 关键约束（自由文本）。 */
  readonly text: string;
  /** 可选标签（如 `handoff` / `reset-point` / `decision`），供过滤。 */
  readonly tags?: readonly string[];
}
