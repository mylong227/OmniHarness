// 长会话虚拟化模型：把「N 个事件块」映射成「可视窗口 + 上下占位高度」，
// 并给出「是否贴底 / 贴底后滚动到哪」的纯策略，供 StreamView 的滚动锚定复用。
//
// 为什么需要：会话事件全量渲染时长会话（数百上千条）的 DOM 节点数随条数线性增长，
// 首屏渲染与滚动都被拖垮。这里只渲染可视窗口 + 上下 overscan（默认各 8 块），
// 未渲染区域用占位高度顶上（padTop / padBottom），使滚动条比例与滚动位置保持稳定。
//
// 估算口径的已知取舍：占位高度按「单块估算高度」计（默认 88px），而非真实测量高度。
// 于是滚动条总高 ≈ 总块数 × 估算高度；单块真实高度差异大（长回复 / 折叠过程簇）时，
// 绝对像素会有漂移，但「窗口占比恒定、滚动位置不跳变、向上滚动不拉回」这三条体验契约成立，
// 且无需 ResizeObserver / 逐块测量（零新增依赖、零 DOM 依赖、可确定性单测）。
//
// 纯计算、零 React、零 DOM：可直接在 node 环境单测（见 web/test/longSessionPerf.test.mjs）。

/** 虚拟窗口的可选参数。 */
export interface StreamWindowOptions {
  /** 单块估算高度（px）：窗口定位与占位高度共用同一口径。 */
  itemHeight?: number;
  /** 可视区上下各额外渲染的块数（滚动时避免露白）。 */
  overscan?: number;
  /** 拿不到 DOM 测量值时的兜底可视高度（px），须为正数。 */
  fallbackViewport?: number;
}

/** 一次窗口计算的产物。 */
export interface StreamWindowMetrics {
  /** 窗口起始块下标（含）。 */
  start: number;
  /** 窗口结束块下标（不含）。 */
  end: number;
  /** 窗口内渲染的块数（= end - start）。 */
  rendered: number;
  /** 顶部占位高度（px）。 */
  padTop: number;
  /** 底部占位高度（px）。 */
  padBottom: number;
  /** 总块数（= 入参 total 的归一化值）。 */
  total: number;
}

/** 最小滚动元素形状：只取贴底判定与定位所需的三个量，便于零 DOM 单测。 */
export interface ScrollBox {
  /** 当前滚动偏移（px）。 */
  scrollTop: number;
  /** 内容总高（px）。 */
  scrollHeight: number;
  /** 可视区高度（px）。 */
  clientHeight: number;
}

/** 贴底判定的像素容差：滚动到「距底不超过该值」即视为在底部（吸底手感）。 */
const BOTTOM_EPSILON = 4;

/** 默认单块估算高度（px）。导出供组合根按同一口径创建 BlockHeightIndex。 */
export const DEFAULT_ITEM_HEIGHT = 88;

/** 默认上下 overscan 块数。 */
const DEFAULT_OVERSCAN = 8;

/** 默认兜底可视高度（px）：中栏流区域的常见高度量级。 */
const DEFAULT_FALLBACK_VIEWPORT = 600;

/** 事件流虚拟窗口计算器（无状态，可复用同一实例）。 */
export class StreamWindow {
  /** 单块估算高度（px），恒为正整数。 */
  private readonly itemHeight: number;
  /** 可视区上下额外渲染的块数。 */
  private readonly overscan: number;
  /** 无法测量 DOM 时使用的兜底可视高度（px）。 */
  private readonly fallbackViewport: number;

  /**
   * @param opts 可选参数（缺省用 88px / 8 块 / 600px 兜底）
   */
  public constructor(opts: StreamWindowOptions = {}) {
    const h = Math.floor(opts.itemHeight ?? DEFAULT_ITEM_HEIGHT);
    const o = Math.floor(opts.overscan ?? DEFAULT_OVERSCAN);
    const f = Math.floor(opts.fallbackViewport ?? DEFAULT_FALLBACK_VIEWPORT);
    this.itemHeight = h > 0 ? h : DEFAULT_ITEM_HEIGHT;
    this.overscan = o >= 0 ? o : DEFAULT_OVERSCAN;
    this.fallbackViewport = f > 0 ? f : DEFAULT_FALLBACK_VIEWPORT;
  }

  /**
   * 计算当前应渲染的块区间与上下占位高度。
   *
   * 渲染块数只与「可视高度 / 估算块高 + overscan」有关，与 total 无关（total 只影响占位高度），
   * 这就是长会话 DOM 节点数不随条数增长的原因。
   * @param total 总块数
   * @param scrollTop 当前滚动偏移（px，负值按 0 处理）
   * @param viewportHeight 可视区高度（px，<= 0 时用构造时的兜底值）
   * @returns 窗口指标（start/end/rendered/padTop/padBottom/total）
   */
  public compute(total: number, scrollTop: number, viewportHeight: number): StreamWindowMetrics {
    const n = Math.max(0, Math.floor(total));
    if (n === 0) {
      return { start: 0, end: 0, rendered: 0, padTop: 0, padBottom: 0, total: 0 };
    }
    const viewport = viewportHeight > 0 ? viewportHeight : this.fallbackViewport;
    const top = scrollTop > 0 ? scrollTop : 0;
    // 首屏可视块数 +1：避免整除边界（正好滚到某块顶端）时少渲染一块。
    const visible = Math.ceil(viewport / this.itemHeight) + 1;
    const first = Math.floor(top / this.itemHeight);
    const start = Math.max(0, first - this.overscan);
    const end = Math.min(n, first + visible + this.overscan);
    const safeStart = Math.min(start, end);
    return {
      start: safeStart,
      end,
      rendered: end - safeStart,
      padTop: safeStart * this.itemHeight,
      padBottom: (n - end) * this.itemHeight,
      total: n,
    };
  }

  /**
   * 按「逐块真实高度」计算虚拟窗口：padTop/padBottom 用前缀偏移累加而非 index×估算，
   * 于是滚动条总高 ≈ Σ真实高度（长回复 / 折叠簇高度差异大时，比统一估算准得多）。
   * 首屏未测到的块由 heightOf 回落到估算值，故「未测量」不崩、只略有偏差。
   * @param keys 当前全部块 key（有序，与 blocks 下标对应）
   * @param heightOf 取某块真实高度的函数（未测到回落估算）
   * @param scrollTop 当前滚动偏移（px）
   * @param viewportHeight 可视区高度（px，<= 0 时用构造时的兜底值）
   * @returns 窗口指标（start/end/rendered/padTop/padBottom/total）
   */
  public computeWithHeights(
    keys: readonly string[],
    heightOf: (key: string) => number,
    scrollTop: number,
    viewportHeight: number,
  ): StreamWindowMetrics {
    const n = Math.max(0, keys.length);
    if (n === 0) {
      return { start: 0, end: 0, rendered: 0, padTop: 0, padBottom: 0, total: 0 };
    }
    const viewport = viewportHeight > 0 ? viewportHeight : this.fallbackViewport;
    const top = scrollTop > 0 ? scrollTop : 0;
    // 前缀偏移表（长度 n+1）：offsets[i] = 前 i 块累计高；offsets[n] = 总高。
    const offsets = new Array<number>(n + 1);
    offsets[0] = 0;
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i]! + heightOf(keys[i]!);
    const totalHeight = offsets[n]!;
    // 窗口起点：最大 i 使 offsets[i] <= top（即「完全滚过」的块数）。
    const start = this.binarySearchFloor(offsets, top);
    // 窗口终点：最小 i 使 offsets[i] >= top + viewport（即首个「在底部之下」的块），再加 overscan。
    let end = this.binarySearchCeil(offsets, top + viewport) + this.overscan;
    end = Math.min(n, end);
    const safeStart = Math.max(0, start - this.overscan);
    return {
      start: safeStart,
      end,
      rendered: end - safeStart,
      padTop: offsets[safeStart]!,
      padBottom: totalHeight - offsets[end]!,
      total: n,
    };
  }

  /**
   * 在单调不降的前缀偏移表里二分：返回最大下标 i 使 offsets[i] <= target。
   * @param offsets 前缀偏移表（offsets[0] = 0，单调不降）
   * @param target 目标偏移（px）
   * @returns 满足条件的最大下标
   */
  private binarySearchFloor(offsets: readonly number[], target: number): number {
    let lo = 0;
    let hi = offsets.length - 1;
    let res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! <= target) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }

  /**
   * 在单调不降的前缀偏移表里二分：返回最小下标 i 使 offsets[i] >= target。
   * @param offsets 前缀偏移表（offsets[0] = 0，单调不降）
   * @param target 目标偏移（px）
   * @returns 满足条件的最小下标
   */
  private binarySearchCeil(offsets: readonly number[], target: number): number {
    let lo = 0;
    let hi = offsets.length - 1;
    let res = offsets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! >= target) {
        res = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return res;
  }

  /**
   * 由「已渲染块的 DOM 实际位置」算出 scrollTop 应做的**自愈校正量**。
   *
   * ## 为什么需要它（2026-09-27 用户报「滚到某区域没有任何显示」）
   *
   * 虚拟窗口的 padTop/padBottom 与滚动定位都基于 `heightOf`（`BlockHeightIndex`：实测 ∪ 估算），
   * 而**浏览器的 scrollTop 是 DOM 高度**。两者只要不一致（估算 88px vs 真实几百 px 的长回复、
   * 簇展开/折叠后索引里的陈旧高、忙/闲分组换掉块含义），模型偏移与真实位置就会错位积累，
   * 表现为「滚到某处视口里全是占位、一个块都没有」（实测真实会话：最差一档视口覆盖率仅 1%，
   * DOM 里明明有 23 个块）。
   *
   * 做法：拿「DOM 里最接近视口顶的那块」当锚，把它**真实的滚动偏移**（`scrollTop + (rect.top - viewportTop)`）
   * 与**模型偏移**（`offsetOf(index)`）对齐，差值就是校正量。锚在视口内时该校正等价于
   * 「上方块高度变化引起的内容跳动」补偿；视口落在空洞里时它把内容重新拉回视口。
   *
   * @param viewportTop 视口顶在文档中的位置（`scroll 容器 rect.top`）
   * @param scrollTop 当前滚动偏移
   * @param anchors 已渲染块的 DOM 锚点（下标 + `getBoundingClientRect()` 的 top/bottom）
   * @param offsetOf 取某块下标对应的**模型**偏移（通常 `BlockHeightIndex.prefix`）
   * @returns 建议叠加到 scrollTop 的校正量（px；锚点为空返回 0）
   */
  public static anchorDelta(
    viewportTop: number,
    scrollTop: number,
    anchors: ReadonlyArray<{ readonly index: number; readonly top: number; readonly bottom: number }>,
    offsetOf: (index: number) => number,
  ): number {
    if (anchors.length === 0) return 0;
    // 优先取「跨过视口顶」的那块；没有则取顶边最接近视口顶的那块。
    let best = anchors[0]!;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const a of anchors) {
      const straddles = a.top <= viewportTop && a.bottom > viewportTop;
      const score = straddles ? 0 : Math.abs(a.top - viewportTop);
      if (score < bestScore) {
        bestScore = score;
        best = a;
      }
      if (score === 0) break;
    }
    const domOffset = scrollTop + (best.top - viewportTop);
    return offsetOf(best.index) - domOffset;
  }

  /**
   * 判断滚动容器是否处于「贴底」状态（内容不足一屏时恒为真）。
   * @param box 滚动容器的最小度量（scrollTop / scrollHeight / clientHeight）
   * @param epsilon 容差像素（缺省 4px）
   * @returns 在底部则 true
   */
  public static atBottom(box: ScrollBox, epsilon: number = BOTTOM_EPSILON): boolean {
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return true;
    return box.scrollTop >= max - epsilon;
  }

  /**
   * 贴底策略：仅当此前处于底部时才把滚动条拉到新内容的底部，
   * 用户上滚查看历史后新事件到达一律保持原 scrollTop（长会话最烦的体验问题）。
   * @param wasAtBottom 上一个滚动事件（或上次提交）时的贴底状态
   * @param box 提交后的滚动容器度量（scrollHeight 已含新内容）
   * @returns 应写回的 scrollTop
   */
  public static stickyScrollTop(wasAtBottom: boolean, box: ScrollBox): number {
    if (!wasAtBottom) return box.scrollTop;
    const target = box.scrollHeight - box.clientHeight;
    return target > 0 ? target : 0;
  }
}
