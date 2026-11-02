/**
 * 三方合并冲突的统一文案（write_file / edit / apply_patch 共用一份口径）。
 *
 * 为什么单独抽：三个工具各写一份「第几行、我方/对方」文案时，措辞与截断长度必然漂移；
 * 而模型看到的下一句是「重读还是换方案」，口径不一会直接诱发无效重试。
 */
import type { TextMergeConflict } from './textThreeWayMerge.ts';

/** 冲突文案格式化器。 */
export class TextMergeConflictMessage {
  /**
   * 生成可行动错误。
   * @param relative 目标相对路径。
   * @param action 动作描述（如「写入」「改写」「应用补丁」）。
   * @param conflicts 冲突区间。
   * @returns 错误文案。
   */
  public static format(
    relative: string,
    action: string,
    conflicts: readonly TextMergeConflict[],
  ): string {
    const detail = conflicts
      .map(
        (conflict) =>
          `第 ${String(conflict.baseStart + 1)}-${String(conflict.baseEnd)} 行` +
          `（我方 ${conflict.ours.slice(0, 160)}｜对方 ${conflict.theirs.slice(0, 160)}）`,
      )
      .join('；');
    return (
      `未${action} ${relative}：与另一会话的改动**在同一区域冲突**（${detail}）。` +
      '为避免覆盖/改错位置，本次未写盘；请 read_file 重读后基于最新内容重试。'
    );
  }
}
