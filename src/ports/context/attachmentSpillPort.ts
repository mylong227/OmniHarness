import type { FileAttachment } from '../model/fileAttachment.ts';

/**
 * 附件外置端口（2026-10-23）：把工具结果里的大附件从**内存事件**移到磁盘，事件只留 `path`。
 *
 * 为什么需要：`SessionAttachmentSpiller` 原先只在 JSONL 落盘时替换副本，内存里的
 * `AppendOnlyEventLog` 仍持有 base64；截图型会话（单张上限 5 MiB）会随会话单调增长。
 * 在记录事件前先外置，模型仍由 `ContextAssembler` 按 `path` 水合，UI 只显示 chip 名称，
 * 因此不损失模型能力。
 */
export interface AttachmentSpillPort {
  /**
   * 外置附件（小附件原样返回）。
   * @param sessionId 会话 ID。
   * @param files 原始附件。
   * @returns 外置后的附件（大附件含相对 sessions 根的 `path`，不含 `data`）。
   */
  spillFiles(
    sessionId: string,
    files: readonly FileAttachment[],
  ): Promise<readonly FileAttachment[]>;
}
