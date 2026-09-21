// 事件流逐块真实高度索引：在零 DOM 的纯模型里维护「块 key → 实测高度」的映射，
// 并为 StreamWindow 的虚拟窗口计算提供「按真实高度的前缀偏移 / 总高」。
//
// 为什么要单独成类：真实的逐块高度只能在浏览器里测到（Ref / getBoundingClientRect），
// 但「偏移累加 / 二分定位 / 失效裁剪」这些纯算术必须可确定性单测（见 web/test/blockHeightIndex.test.mjs），
// 故把状态与算术收进本类，DOM 测量只负责 fill 这个索引（见 web/src/ui/components/StreamView.tsx）。
//
// 未测到的块一律回落到构造时给定的估算高度，因此「首屏未测量」与「长会话顶部块」不会崩；
// 误差阈值 EPS 保证「亚像素抖动」不触发无谓的二次重渲染（避免测量→重排→再测量的死循环）。

/** 逐块高度索引的可选参数。 */
export interface BlockHeightIndexOptions {
  /** 未实测块的回落高度（px），恒为正。 */
  estimate?: number;
  /** 高度下限（px）：任何实测 / 回落都不会低于它，防御 0 或负值把占位压没。 */
  min?: number;
  /** 高度上限（px）：防御异常高的块（如超大图片）把滚动条顶爆，超过即截断。 */
  max?: number;
}

/** 高度写入判定用的亚像素误差阈值（px）：差在此之内视为「没变」。 */
const HEIGHT_EPSILON = 0.5;

/** 默认回落高度（px），与 StreamWindow 的 DEFAULT_ITEM_HEIGHT 保持一致。 */
const DEFAULT_ESTIMATE = 88;

/** 默认高度下限（px）。 */
const DEFAULT_MIN = 8;

/** 默认高度上限（px）：约 30 屏，足够覆盖任何单块，同时避免异常值撑爆滚动条。 */
const DEFAULT_MAX = 30000;

/** 事件流逐块真实高度索引（有状态、零 DOM、可确定性单测）。 */
export class BlockHeightIndex {
  /** 未实测块的回落高度（px）。 */
  private readonly estimate: number;
  /** 高度下限（px）。 */
  private readonly min: number;
  /** 高度上限（px）。 */
  private readonly max: number;
  /** 已实测高度表：块 key → 高度（px）。 */
  private readonly measured = new Map<string, number>();

  /**
   * @param opts 可选参数（缺省用 88 / 8 / 30000）
   */
  public constructor(opts: BlockHeightIndexOptions = {}) {
    const e = Number(opts.estimate ?? DEFAULT_ESTIMATE);
    const mn = Number(opts.min ?? DEFAULT_MIN);
    const mx = Number(opts.max ?? DEFAULT_MAX);
    this.estimate = e > 0 ? e : DEFAULT_ESTIMATE;
    this.min = mn > 0 ? mn : DEFAULT_MIN;
    this.max = mx > this.min ? mx : DEFAULT_MAX;
  }

  /**
   * 读取某块高度：已实测返回实测值，否则回落估算高度。
   * @param key 块 key
   * @returns 该块高度（px）
   */
  public get(key: string): number {
    const v = this.measured.get(key);
    return v !== undefined ? v : this.estimate;
  }

  /**
   * 写入某块实测高度；与既有值差超过 EPS 才真正更新（亚像素抖动不触发重渲染）。
   * @param key 块 key
   * @param raw 浏览器量到的原始高度（px，可为分数）
   * @returns 真值发生变化则为 true
   */
  public set(key: string, raw: number): boolean {
    const h = this.clamp(raw);
    const prev = this.measured.get(key);
    if (prev !== undefined && Math.abs(prev - h) <= HEIGHT_EPSILON) return false;
    this.measured.set(key, h);
    return true;
  }

  /**
   * 是否已实测过某块（用于判断回落是否仍生效）。
   * @param key 块 key
   * @returns 已实测为 true
   */
  public has(key: string): boolean {
    return this.measured.has(key);
  }

  /**
   * 删除某块记录（事件被撤回时使用）。
   * @param key 块 key
   * @returns 无（仅副作用：从索引移除该块）
   */
  public delete(key: string): void {
    this.measured.delete(key);
  }

  /**
   * 裁剪索引：只保留 keep 里出现的 key，丢弃已不存在的块（防长会话无限增长）。
   * @param keep 当前仍存在的块 key 集合
   * @returns 被丢弃的条数
   */
  public prune(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const k of [...this.measured.keys()]) {
      if (!keep.has(k)) {
        this.measured.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 按真实高度累加前 count 个块的总高（padTop 用）。
   * @param keys 当前全部块 key（有序）
   * @param count 累加前 count 个（0 返回 0；越界按数组长度）
   * @returns 前缀高度（px）
   */
  public prefix(keys: readonly string[], count: number): number {
    const n = Math.max(0, Math.min(count, keys.length));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.get(keys[i]!);
    return sum;
  }

  /**
   * 全部块按真实高度的总高（滚动条总高用）。
   * @param keys 当前全部块 key（有序）
   * @returns 总高（px）
   */
  public total(keys: readonly string[]): number {
    return this.prefix(keys, keys.length);
  }

  /**
   * 已实测条数（用于诊断 / 测试断言）。
   * @returns 实测条数
   */
  public size(): number {
    return this.measured.size;
  }

  /**
   * 清空全部记录（切换会话时调用）。
   * @returns 无（仅副作用：清空全部实测记录）
   */
  public clear(): void {
    this.measured.clear();
  }

  /**
   * 导出快照（只读副本，供测试 / 诊断）。
   * @returns key → 高度的纯对象
   */
  public snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.measured) out[k] = v;
    return out;
  }

  /**
   * 把任意原始高度裁进 [min, max]（零 / 负 / 非有限数回落到 min）。
   * @param raw 原始高度
   * @returns 裁剪后的高度
   */
  private clamp(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) return this.min;
    if (raw > this.max) return this.max;
    return raw;
  }
}
