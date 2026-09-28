import type { MediaFrame } from '../ports/media/mediaTypes.js';
import type { RasterImage } from './rasterTypes.js';
import { PngEncoder } from './pngEncoder.js';
import { RasterScaler } from './rasterScaler.js';

/** 单帧缩放的最小长边：再小就已经看不清内容，宁可丢弃并如实告知。 */
const MIN_DIMENSION = 96;

/** 缩放重试上限：每次乘 {@link SHRINK_RATIO}，6 次可把 1024 长边降到约 180。 */
const MAX_SHRINK_ATTEMPTS = 6;

/** 单次缩放比例。 */
const SHRINK_RATIO = 0.75;

/** 编码结果。 */
export interface FrameEncodeOutcome {
  /** 是否成功产出可交付的帧。 */
  readonly ok: boolean;
  /** 成功时的 PNG 字节。 */
  readonly bytes: Buffer | undefined;
  /** 编码后宽度。 */
  readonly width: number;
  /** 编码后高度。 */
  readonly height: number;
  /** 是否发生了缩小（用于如实告知模型「已降采样」）。 */
  readonly shrunk: boolean;
  /** 失败原因（`ok:false` 时必有值）。 */
  readonly reason: string | undefined;
}

/**
 * 帧编码器：把一帧 RGBA 像素变成「在字节预算内的 PNG」。
 *
 * ## 预算为什么是硬约束
 *
 * 每交付一帧，它都会以 base64 形式进入模型上下文——**大小即成本，超限即报错**。
 * 故本类按「先按长边上限缩放 → 编码 → 仍超单帧上限则继续缩小 → 仍超则丢弃并说明」
 * 四步走完，任何一步都不静默：缩小了记 `shrunk`，丢弃了给出 `reason`，
 * 由调用方把这些事实逐条回灌给模型（模型据此知道"这帧是缩过的"）。
 *
 * ## 为什么用 PNG 而不是 JPEG（GIF 路径）
 *
 * GIF 是调色板 + 大面积纯色的图像，PNG 无损且**更小**；而 JPEG 会在色块边缘产生振铃，
 * 反而干扰「这个色块是什么颜色」这类判读。视频路径另用 JPEG（见 `FfmpegFrameExtractor`），
 * 因为那儿是连续色调画面，PNG 体积会大一个量级。
 */
export class FrameEncoder {
  /**
   * @param maxDimension 单帧长边上限（像素）。
   * @param maxFrameBytes 单帧字节上限。
   */
  public constructor(
    private readonly maxDimension: number,
    private readonly maxFrameBytes: number,
  ) {}

  /**
   * 编码一帧（必要时缩小）。
   *
   * @param raster 已合成的整图帧（RGBA）。
   * @returns 编码结果；超出预算且缩无可缩时 `ok:false` 并给出原因。
   */
  public encode(raster: RasterImage): FrameEncodeOutcome {
    let current = RasterScaler.fit(raster, this.maxDimension);
    let shrunk = current !== raster;
    let lastBytes = 0;
    for (let attempt = 0; attempt <= MAX_SHRINK_ATTEMPTS; attempt += 1) {
      const bytes = PngEncoder.encode(current);
      lastBytes = bytes.byteLength;
      if (bytes.byteLength <= this.maxFrameBytes) {
        return {
          ok: true,
          bytes,
          width: current.width,
          height: current.height,
          shrunk,
          reason: undefined,
        };
      }
      const longest = Math.max(current.width, current.height);
      if (attempt === MAX_SHRINK_ATTEMPTS || longest <= MIN_DIMENSION) {
        break;
      }
      current = RasterScaler.resize(
        current,
        Math.max(MIN_DIMENSION, Math.round(current.width * SHRINK_RATIO)),
        Math.max(MIN_DIMENSION, Math.round(current.height * SHRINK_RATIO)),
      );
      shrunk = true;
    }
    return {
      ok: false,
      bytes: undefined,
      width: current.width,
      height: current.height,
      shrunk,
      reason:
        `单帧编码后 ${String(lastBytes)} 字节，超过单帧上限 ` +
        `${String(this.maxFrameBytes)} 字节，且已缩到 ${String(current.width)}×` +
        `${String(current.height)} 仍不达标`,
    };
  }
}

/** 总字节预算裁剪的结果。 */
export interface FrameBudgetOutcome {
  /** 裁剪后保留的帧（按原顺序）。 */
  readonly frames: readonly MediaFrame[];
  /** 被丢弃的帧数（0 表示未裁剪）。 */
  readonly dropped: number;
}

/**
 * 帧集合的**总字节**预算裁剪器。
 *
 * 单帧达标不等于整体达标：8 帧各 1.4 MB 合计 11 MB，base64 后近 15 MB，
 * 会把上下文与端点请求体一起撑爆。故在单帧上限之外还有一条**总额上限**。
 *
 * 裁剪方式同样是「均匀保留子集」：从「尽量多保留」开始逐档减少，直到总额达标——
 * 这与「丢掉最后几帧」有本质区别：后者会让模型完全看不到结尾部分
 * （而视频结尾往往是结论所在）。
 */
export class MediaFrameBudget {
  /**
   * 按总字节上限裁剪帧集合。
   *
   * @param frames 已完成单帧预算的帧（按时间升序）。
   * @param maxTotalBytes 总字节上限（≤0 表示不限制）。
   * @returns 保留的帧与被丢弃的帧数。
   */
  public static trim(frames: readonly MediaFrame[], maxTotalBytes: number): FrameBudgetOutcome {
    const total = frames.reduce((sum, frame) => sum + frame.bytes.byteLength, 0);
    if (maxTotalBytes <= 0 || total <= maxTotalBytes || frames.length <= 1) {
      return { frames, dropped: 0 };
    }
    for (let keep = frames.length - 1; keep >= 1; keep -= 1) {
      const subset = MediaFrameBudget.evenlySpaced(frames, keep);
      const bytes = subset.reduce((sum, frame) => sum + frame.bytes.byteLength, 0);
      if (bytes <= maxTotalBytes) {
        return {
          frames: MediaFrameBudget.renumber(subset),
          dropped: frames.length - subset.length,
        };
      }
    }
    return {
      frames: MediaFrameBudget.renumber(frames.slice(0, 1)),
      dropped: frames.length - 1,
    };
  }

  /**
   * 重编帧序号（裁剪后序号必须连续，否则模型会以为「中间少的那几帧被跳过了」）。
   *
   * @param frames 帧集合（升序）。
   * @returns 序号重编后的帧集合（`index` 从 0 连续递增）。
   */
  private static renumber(frames: readonly MediaFrame[]): readonly MediaFrame[] {
    return frames.map((frame, index) => ({ ...frame, index }));
  }

  /**
   * 从帧集合中等距取 `keep` 帧。
   *
   * @param frames 源帧（升序）。
   * @param keep 目标帧数（1 ≤ keep < frames.length）。
   * @returns 等距子集（保持升序）。
   */
  private static evenlySpaced(frames: readonly MediaFrame[], keep: number): readonly MediaFrame[] {
    const last = frames.length - 1;
    if (keep === 1) {
      return [frames[Math.floor(last / 2)] as MediaFrame];
    }
    const step = last / (keep - 1);
    const picked: MediaFrame[] = [];
    for (let index = 0; index < keep; index += 1) {
      picked.push(frames[Math.round(index * step)] ?? (frames[last] as MediaFrame));
    }
    return picked;
  }
}
