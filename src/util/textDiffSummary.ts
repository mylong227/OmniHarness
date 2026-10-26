/**
 * 文本差异**摘要**（不是补丁）：给冲突错误一句可行动的话——"从第几行起、增删了多少行"。
 *
 * 为什么不做完整 diff/LCS：冲突文案要短、要稳定、不能把两份大文件都塞回模型上下文；
 * 找**公共前缀 + 公共后缀**后剩下的中段就是差异范围，O(n) 且没有歧义。完整 diff 仍由
 * `git diff` / 专用 diff 工具提供。
 */
export class TextDiffSummary {
  /**
   * 生成摘要。
   * @param before 改动前文本。
   * @param after 改动后文本。
   * @returns 一句中文摘要（两文本相同时返回"内容相同"）。
   */
  public static of(before: string, after: string): string {
    if (before === after) return '内容相同';
    const oldLines = TextDiffSummary.linesOf(before);
    const newLines = TextDiffSummary.linesOf(after);
    let prefix = 0;
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const removed = oldLines.length - prefix - suffix;
    const added = newLines.length - prefix - suffix;
    const at = `第 ${String(prefix + 1)} 行起`;
    if (oldLines.length === 0) return `${at}新增 ${String(added)} 行`;
    if (newLines.length === 0) return `${at}删除 ${String(removed)} 行`;
    return `${at} -${String(removed)} 行 / +${String(added)} 行（总行数 ${String(oldLines.length)} → ${String(newLines.length)}）`;
  }

  /**
   * 按行切分（保留空文件为 0 行；末尾换行不产生额外空行）。
   * @param text 文本。
   * @returns 行数组。
   */
  private static linesOf(text: string): string[] {
    if (text === '') return [];
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
    return normalized.split('\n');
  }
}
