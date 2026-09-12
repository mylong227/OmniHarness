// token 数量与人读比例的格式化：纯逻辑、零 React 依赖，node 环境可直接单测。

/**
 * token 数量 / 百分比格式化器。
 *
 * 中文量级用「万 / 亿」而不是「k / M」：面板的核心数字（如 11.7万 / 100万）
 * 一旦写成 117k / 1M，中文用户要在脑子里做一次万位换算，而容量判断恰恰依赖这个量级感。
 * 规则与截图里的表述保持一致：≥1 万进「万」，≥1 亿进「亿」，小数最多一位且不留 `.0`。
 */
export class TokenScaleFormatter {
  /** 万的进位数。 */
  private static readonly WAN = 10_000;
  /** 亿的进位数。 */
  private static readonly YI = 100_000_000;

  /**
   * 紧凑格式：`117000 → 11.7万`、`1000000 → 100万`、`9999 → 9999`。
   * @param tokens token 数（负数/非有限数按 0 处理——面板不该出现 `NaN万`）
   * @returns 紧凑字符串
   */
  public compact(tokens: number): string {
    const value = this.safe(tokens);
    if (value >= TokenScaleFormatter.YI) {
      return this.trim(value / TokenScaleFormatter.YI) + '亿';
    }
    if (value >= TokenScaleFormatter.WAN) {
      return this.trim(value / TokenScaleFormatter.WAN) + '万';
    }
    return String(Math.round(value));
  }

  /**
   * 百分比文本。
   * @param value 百分比数值（0–100）；`undefined` / 非有限数返回 `—`（表示「未知」，不是 0%）
   * @returns 形如 `11.7%` / `100%` / `—`
   */
  public percent(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '—';
    return this.trim(value) + '%';
  }

  /**
   * 计算 part 占 whole 的百分比（一位小数）。
   * @param part 分子
   * @param whole 分母（≤0 时返回 0，避免除零产出 `Infinity%`）
   * @returns 百分比数值（0–100 区间外不裁剪，交由调用方按需 clamp）
   */
  public ratio(part: number, whole: number): number {
    if (!Number.isFinite(whole) || whole <= 0) return 0;
    return Math.round((this.safe(part) / whole) * 1000) / 10;
  }

  /**
   * 夹紧到 0–100（进度条宽度只接受该区间）。
   * @param percent 百分比
   * @returns 0–100 之间的数值
   */
  public clampPercent(percent: number): number {
    if (!Number.isFinite(percent)) return 0;
    return Math.min(100, Math.max(0, percent));
  }

  /** 转成分值（一位小数，去掉无意义的 `.0`）。 */
  private trim(value: number): string {
    if (!Number.isFinite(value)) return '0';
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  /** 归一化非有限数为 0。 */
  private safe(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }
}
