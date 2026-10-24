/** 单文件快照条目。 */
export interface FileSnapshotEntry {
  /** 相对工作区根的路径。 */
  readonly relPath: string;
  /**
   * 回滚目标内容；`null` 表示该文件在快照时刻并不存在（会话中新建的未跟踪文件），
   * 回滚时应被删除。
   *
   * 文本默认按 UTF-8 存储；二进制条目用 {@link encoding} 标记为 `base64`。
   */
  readonly content: string | null;
  /**
   * 内容编码（可选，缺省 `utf8`）。
   *
   * 为什么需要（2026-10-23）：快照原先对所有文件 `toString('utf8')`，PNG/PDF/压缩包等
   * 非 UTF-8 字节会被替换成 U+FFFD，回滚即损坏文件。二进制现在用 base64 原样保存。
   */
  readonly encoding?: 'utf8' | 'base64' | undefined;
  /**
   * 是否因上限/预算被跳过（可选）。
   *
   * 跳过的条目**不得**在 restore 时被当成「删除」——它们只是「没能力安全回滚」，
   * 保留现场并如实标记，比静默截断/损坏安全。
   */
  readonly skipped?: boolean | undefined;
  /** 跳过原因（`skipped=true` 时给模型/用户看）。 */
  readonly skipReason?: string | undefined;
}
