// 数字格式化：指标面板用的千分位缩写与统计展示。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 千分位缩写器：1234 → 1.2k，1234567 → 1.23M。 */
export class NumberFormatter {
  /** 缩写整数：百万级两位小数、千级一位小数，以下原样输出；非有限数统一显示占位符。 */
  static abbrev(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }
}
