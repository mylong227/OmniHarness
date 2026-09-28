/** PNG 行过滤器类型（规范定义 5 种，取值 0–4）。 */
const FILTER_COUNT = 5;

/** 每像素字节数（RGBA 8 位恒为 4）。 */
const BYTES_PER_PIXEL = 4;

/**
 * PNG 行过滤器选择器（自适应最小绝对差启发式，PNG 规范 推荐的默认策略）。
 *
 * ## 为什么需要
 *
 * PNG 的压缩率几乎完全取决于「行内差值有多小」：原样存储照片行，deflate 只能压掉一点点；
 * 而按 Sub/Up/Paeth 预先转成差分，同样内容能小一个量级。逐帧 PNG 会作为附件进入模型上下文，
 * **体积直接等于 token 成本**，因此这不是微优化，而是产品行为。
 *
 * ## 算法（规范附录给出的启发式）
 *
 * 对每一行分别尝试 5 种过滤，取「过滤后字节按**有符号**绝对值求和」最小者——
 * 该和是压缩后大小的可靠代理量。选择过程是确定性的（同输入恒同输出），便于逐字节断言。
 */
export class PngFilterSelector {
  /**
   * 生成过滤后的扫描线缓冲（每行首字节为过滤类型）。
   *
   * @param rgba 原始 RGBA 像素缓冲（行优先）。
   * @param width 宽度（像素）。
   * @param height 高度（像素）。
   * @returns 过滤后的字节流（长度 = `height × (1 + width × 4)`）。
   */
  public static apply(rgba: Uint8Array, width: number, height: number): Uint8Array {
    const stride = width * BYTES_PER_PIXEL;
    const filtered = new Uint8Array(height * (stride + 1));
    const candidates = Array.from({ length: FILTER_COUNT }, () => new Uint8Array(stride));
    for (let row = 0; row < height; row += 1) {
      const source = row * stride;
      const previous = source - stride;
      let bestType = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let type = 0; type < FILTER_COUNT; type += 1) {
        const target = candidates[type] as Uint8Array;
        const score = PngFilterSelector.score(rgba, source, previous, stride, type, target);
        if (score < bestScore) {
          bestScore = score;
          bestType = type;
        }
      }
      const destination = row * (stride + 1);
      filtered[destination] = bestType;
      filtered.set(candidates[bestType] as Uint8Array, destination + 1);
    }
    return filtered;
  }

  /**
   * 计算某一行的某种过滤结果，并返回其绝对差评分。
   *
   * @param rgba 原始像素缓冲。
   * @param source 当前行起始偏移。
   * @param previous 上一行起始偏移（`<0` ＝不存在，按全 0 处理）。
   * @param stride 行字节数。
   * @param type 过滤类型（0–4）。
   * @param target 输出缓冲（长度 = `stride`）。
   * @returns 绝对差评分（越小越好）。
   */
  private static score(
    rgba: Uint8Array,
    source: number,
    previous: number,
    stride: number,
    type: number,
    target: Uint8Array,
  ): number {
    let total = 0;
    for (let offset = 0; offset < stride; offset += 1) {
      const left = offset >= BYTES_PER_PIXEL ? (rgba[source + offset - BYTES_PER_PIXEL] ?? 0) : 0;
      const up = previous >= 0 ? (rgba[previous + offset] ?? 0) : 0;
      const upLeft =
        previous >= 0 && offset >= BYTES_PER_PIXEL
          ? (rgba[previous + offset - BYTES_PER_PIXEL] ?? 0)
          : 0;
      const value = rgba[source + offset] ?? 0;
      const filtered = (value - PngFilterSelector.predictor(type, left, up, upLeft)) & 0xff;
      target[offset] = filtered;
      total += filtered < 128 ? filtered : 256 - filtered;
    }
    return total;
  }

  /**
   * 取过滤类型对应的预测值。
   *
   * @param type 过滤类型（0 原始 / 1 Sub / 2 Up / 3 Average / 4 Paeth）。
   * @param left 左侧像素字节（a）。
   * @param up 上方像素字节（b）。
   * @param upLeft 左上像素字节（c）。
   * @returns 预测值（0–255）。
   */
  private static predictor(type: number, left: number, up: number, upLeft: number): number {
    switch (type) {
      case 1:
        return left;
      case 2:
        return up;
      case 3:
        return (left + up) >> 1;
      case 4:
        return PngFilterSelector.paeth(left, up, upLeft);
      default:
        return 0;
    }
  }

  /**
   * Paeth 预测（规范定义：取 a+b−c 的最近邻居）。
   *
   * @param left a。
   * @param up b。
   * @param upLeft c。
   * @returns 预测值。
   */
  private static paeth(left: number, up: number, upLeft: number): number {
    const estimate = left + up - upLeft;
    const distanceLeft = Math.abs(estimate - left);
    const distanceUp = Math.abs(estimate - up);
    const distanceUpLeft = Math.abs(estimate - upLeft);
    if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
      return left;
    }
    return distanceUp <= distanceUpLeft ? up : upLeft;
  }
}
