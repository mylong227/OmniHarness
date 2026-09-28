import type { GifDecodedFrame } from './gifTypes.js';

/**
 * 判定「像素是否变化」的单像素通道差之和阈值（RGB 各通道差的绝对值之和）。
 *
 * 取 72（平均每通道 24/255）的理由：JPEG/调色板量化与抖动会带来 ±8 量级的噪声，
 * 而真正的内容变化（物体出现、画面切换）远超此量级。阈值过低会把压缩噪声当变化
 * （于是"场景采样"退化成"全取"），过高则漏掉细微但关键的变化（如指示灯亮起）。
 * 该值可通过配置调整（`media.sceneThreshold` 作用于下面的**比例**，本常量只定单像素判据）。
 */
const PIXEL_CHANGE_SUM = 72;

/** 场景采样的帧数与间隔约束。 */
export interface SceneSelectionOptions {
  /** 变化比例阈值（0–1）：整帧中「变化像素占比」超过它才算场景切换。 */
  readonly threshold: number;
  /** 最多保留多少帧。 */
  readonly maxFrames: number;
  /** 两个保留帧之间的最小时间间隔（毫秒）：防止一次剧烈运动刷出一串帧。 */
  readonly minGapMs: number;
}

/** 被场景采样选中的帧（含像素，供上层编码）。 */
export interface SceneSelectedFrame {
  /** 源帧序号。 */
  readonly sourceIndex: number;
  /** 起始时间（毫秒）。 */
  readonly timestampMs: number;
  /** 显示时长（毫秒）；未知为 `undefined`。 */
  readonly delayMs: number | undefined;
  /** 画布像素（RGBA）。 */
  readonly rgba: Uint8Array;
  /** 宽度。 */
  readonly width: number;
  /** 高度。 */
  readonly height: number;
}

/**
 * 场景选择器：在**流式**解码过程中挑出「画面确实变了」的帧，内存有界。
 *
 * ## 为什么是流式（而不是「先全解出来再挑」）
 *
 * 一部 30 秒 1080p 视频解成 RGBA 是十几 GB——先把所有帧攒起来再挑，等于给自己造内存炸弹。
 * 本类只保留：① 上一帧（做相邻比较）② 已选中的帧（≤ `maxFrames`）。
 * 因此峰值内存 = `(maxFrames + 1) × 单帧字节`，与源长度无关。
 *
 * ## 帧数超限时的处理：**抽稀**而不是「先到先得」
 *
 * 若场景变化帧比 `maxFrames` 还多，最自然的错误做法是「取前 N 个」——那会让采样
 * 严重偏向视频开头（模型看到的全是前 10 秒）。本类采用**抽稀**：一旦超出上限，
 * 保留偶数位、并把最小间隔翻倍。于是帧集合始终是均匀铺满整条时间轴的，
 * 只是密度随预算下降——这正是"有界预算下最不坏的时序覆盖"。
 *
 * ## 与 ffmpeg 路径的关系
 *
 * 视频侧的场景检测由 ffmpeg 的 `scene` 分数完成（那是公认的口径与实现），
 * 本类服务于 **GIF 侧**（没有外部工具可用）。两者都以「变化像素占比」为语义，
 * 故同一个 `sceneThreshold` 配置对两条路含义一致。
 */
export class FrameSceneSelector {
  /** 已选中的帧。 */
  private readonly kept: SceneSelectedFrame[] = [];
  /** 上一帧的像素（相邻比较用）。 */
  private previous: Uint8Array | undefined;
  /** 当前生效的最小间隔（抽稀时会翻倍）。 */
  private minGapMs: number;

  /**
   * @param options 采样约束。
   */
  public constructor(private readonly options: SceneSelectionOptions) {
    this.minGapMs = options.minGapMs;
  }

  /** 已选中的帧（按时间升序）。 */
  public get selected(): readonly SceneSelectedFrame[] {
    return this.kept;
  }

  /**
   * 计算机械两帧之间的「变化像素占比」。
   *
   * @param previous 前一帧像素（RGBA）。
   * @param current 当前帧像素（RGBA）。
   * @returns 变化像素占比（0–1）；尺寸不一致时按较小长度比较。
   */
  public static changedFraction(previous: Uint8Array, current: Uint8Array): number {
    const length = Math.min(previous.length, current.length);
    const pixels = Math.floor(length / 4);
    if (pixels === 0) {
      return 0;
    }
    let changed = 0;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const offset = pixel * 4;
      const delta =
        Math.abs((previous[offset] ?? 0) - (current[offset] ?? 0)) +
        Math.abs((previous[offset + 1] ?? 0) - (current[offset + 1] ?? 0)) +
        Math.abs((previous[offset + 2] ?? 0) - (current[offset + 2] ?? 0));
      if (delta > PIXEL_CHANGE_SUM) {
        changed += 1;
      }
    }
    return changed / pixels;
  }

  /**
   * 送入一帧参与判定（按时间顺序调用）。
   *
   * @param frame 已解码的帧（须带像素）。
   * @returns 无返回值。
   */
  public consider(frame: GifDecodedFrame): void {
    // 首帧无条件保留：没有前帧可比，变化率必须是 1（而不是「跳过」——首帧往往就是初始态）。
    // 这里直接判 `this.previous` 而不先存一个 `isFirst` 布尔：布尔变量不能在下面的三元里
    // 为 TS 提供收窄，改判字段本身才既收窄又少一个状态。
    const fraction =
      this.previous === undefined
        ? 1
        : FrameSceneSelector.changedFraction(this.previous, frame.rgba);
    this.previous = frame.rgba;
    if (fraction < this.options.threshold) {
      return;
    }
    const last = this.kept[this.kept.length - 1];
    if (last !== undefined && frame.timestampMs - last.timestampMs < this.minGapMs) {
      return;
    }
    this.kept.push({
      sourceIndex: frame.sourceIndex,
      timestampMs: frame.timestampMs,
      delayMs: frame.delayMs,
      rgba: frame.rgba,
      width: frame.width,
      height: frame.height,
    });
    if (this.kept.length > this.options.maxFrames) {
      this.decimate();
    }
  }

  /**
   * 抽稀：保留偶数位并把最小间隔翻倍（保证时间轴覆盖，而非偏袒开头）。
   *
   * @returns 无返回值。
   */
  private decimate(): void {
    const survivors = this.kept.filter((_frame, index) => index % 2 === 0);
    this.kept.length = 0;
    this.kept.push(...survivors);
    this.minGapMs *= 2;
  }
}
