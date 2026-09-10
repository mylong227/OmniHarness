// 文件体积格式化：字节数转人类可读字符串。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 文件体积格式化器。 */
export class FileSizeFormatter {
  /** 格式化：<1KB 用 B，<1MB 用 KB（一位小数），其余用 MB（一位小数）。 */
  public static human(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
}
