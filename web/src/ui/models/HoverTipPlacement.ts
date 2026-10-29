// 悬浮提示的落位计算（纯函数、零 DOM）：优先落在锚点**上方**，上方放不下改到下方，
// 水平居中后再夹进视口边距内。
//
// ## 为什么单独成模型
// 真机上提示最容易出丑的地方不是样式，而是**贴边**：左栏会话行离窗口左缘只有 8px，
// 居中后气泡左半截会跑出屏幕；输入区的权限 chip 贴着窗口底部，上方够、下方不够。
// 这些边界在跑浏览器之前就该被算清楚并判据化（jsdom 没有布局，量不出来）。

/** 锚点矩形（视口坐标，等价于 `getBoundingClientRect()` 的可测子集）。 */
export interface TipAnchor {
  /** 左缘。 */
  readonly left: number;
  /** 上缘。 */
  readonly top: number;
  /** 右缘。 */
  readonly right: number;
  /** 下缘。 */
  readonly bottom: number;
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 气泡尺寸（px）。 */
export interface TipSize {
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 视口尺寸（px）。 */
export interface TipViewport {
  /** 视口宽。 */
  readonly width: number;
  /** 视口高。 */
  readonly height: number;
}

/** 落位结果（`left` / `top` 直接用于 `position: fixed`）。 */
export interface TipPosition {
  /** 左缘（已夹进视口）。 */
  readonly left: number;
  /** 上缘（已夹进视口）。 */
  readonly top: number;
  /** 实际落在锚点哪一侧。 */
  readonly side: 'above' | 'below';
}

/** 气泡与锚点的间距（px）：贴太近会像元素自己的一部分。 */
export const TIP_GAP = 8;
/** 气泡与视口边缘的最小间距（px）：贴边会让圆角看起来被裁掉。 */
export const TIP_MARGIN = 8;

/**
 * 悬浮提示落位。
 */
export class HoverTipPlacement {
  /**
   * 算一次落位。
   *
   * 口径：① 优先上方；上方装不下才翻到下方；两边都装不下时仍选上方并夹紧（提示贴着锚点，
   * 至少还能读）；② 水平居中，随后夹进 `[margin, 视口 - margin - 宽]`；③ 结果取整，
   * 避免亚像素定位让 1px 描边/文字发虚。
   * @param anchor 锚点矩形（视口坐标）
   * @param size 气泡尺寸
   * @param viewport 视口尺寸
   * @param gap 与锚点的间距
   * @param margin 与视口边缘的最小间距
   * @returns 落位（left / top / side）
   */
  public static place(
    anchor: TipAnchor,
    size: TipSize,
    viewport: TipViewport,
    gap: number = TIP_GAP,
    margin: number = TIP_MARGIN,
  ): TipPosition {
    const fitsAbove = anchor.top - gap - size.height >= margin;
    const fitsBelow = anchor.bottom + gap + size.height <= viewport.height - margin;
    const side: 'above' | 'below' = fitsAbove || !fitsBelow ? 'above' : 'below';
    const rawTop = side === 'above' ? anchor.top - gap - size.height : anchor.bottom + gap;
    return {
      left: Math.round(
        HoverTipPlacement.clamp(anchor.left + anchor.width / 2 - size.width / 2, margin, viewport.width - margin - size.width),
      ),
      top: Math.round(HoverTipPlacement.clamp(rawTop, margin, viewport.height - margin - size.height)),
      side,
    };
  }

  /**
   * 把值夹进区间；区间本身为负（气泡比视口还大）时退回下界，保证不出现"越夹越出界"。
   * @param value 原值
   * @param min 下界
   * @param max 上界
   * @returns 夹紧后的值
   */
  private static clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, Math.max(min, max)));
  }
}
