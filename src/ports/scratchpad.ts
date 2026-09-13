/**
 * Scratchpad 端口（T3.4 · 重置点 + 交接物）。
 *
 * 解决的问题：上下文重置（compact / 会话中断 / 换会话续跑）后，"当前任务进行到哪、
 * 下一步做什么、有哪些已确认的约束"这些**工作记忆**随上下文一起消失，agent 只能
 * 从头推断。scratchpad 是一层**跨重置存活的便签**：agent 在关键节点写入交接物
 * （handoff），重置后第一件事读回最新便签，即可恢复任务而非重新考古事件日志。
 *
 * 设计约束：
 * - 与检查点互补：checkpoint 存完整事件流状态（重、贵），scratchpad 只存语义摘要（轻、人类可读）。
 * - fail-soft：读写失败一律降级为空态，绝不因便签故障阻断主流程。
 */
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

/** Scratchpad 端口：跨上下文重置的轻量工作记忆。 */
export interface ScratchpadPort {
  readonly name: string;
  /** 追加一条便签（fail-soft：写失败不抛错）。 */
  append(text: string, tags?: readonly string[]): ScratchpadNote | undefined;
  /** 最近 k 条（默认 10，新在前）。 */
  recent(k?: number): readonly ScratchpadNote[];
  /** 最新一条（无则 undefined）——重置后恢复任务的入口。 */
  latest(): ScratchpadNote | undefined;
  /** 清空（新任务开编）。 */
  clear(): void;
}
