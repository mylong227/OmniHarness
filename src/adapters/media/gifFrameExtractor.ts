import { readFile, stat } from 'node:fs/promises';
import { GifDecoder } from '../../media/gifDecoder.js';
import { FrameEncoder, MediaFrameBudget } from '../../media/frameEncoder.js';
import { FrameSceneSelector } from '../../media/frameSceneSelector.js';
import { MediaFrameSampler } from '../../media/mediaFrameSampler.js';
import type { GifAnimation, GifFrameTiming } from '../../media/gifTypes.js';
import type {
  FrameExtractionRequest,
  FrameExtractionResult,
  MediaFrameExtractor,
} from '../../ports/media/frameExtractor.js';
import type { MediaFrame, MediaKind, MediaProbeInfo } from '../../ports/media/mediaTypes.js';

/** 结构扫描的帧数硬上限：病态/恶意 GIF 不得把扫描变成无限循环。 */
const STRUCTURE_FRAME_CAP = 100_000;

/** 场景采样的最小帧间隔（毫秒）：防止一次剧烈运动刷出一串帧。 */
const SCENE_MIN_GAP_MS = 120;

/** 待编码的帧（像素已在手，尚未编码）。 */
interface EncodableFrame {
  /** 源帧序号。 */
  readonly sourceIndex: number;
  /** 起始时间（毫秒）。 */
  readonly timestampMs: number;
  /** 显示时长（毫秒）；未知为 `undefined`。 */
  readonly durationMs: number | undefined;
  /** 画布像素（RGBA）。 */
  readonly rgba: Uint8Array;
  /** 宽度。 */
  readonly width: number;
  /** 高度。 */
  readonly height: number;
}

/** 采样窗口。 */
interface SampleWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * 动画 GIF 帧提取器（纯 TS，零外部二进制）。
 *
 * ## 两条采样路径，各自只解该解的像素
 *
 * - **均匀采样**：先做**结构扫描**（不解 LZW、不合成像素）拿到时间轴 → 算出时间点 →
 *   再做**定向解码**（`wantedIndices` + `stopAfterIndex`：只解到最后一个被选中的帧，
 *   且不为未选中的帧做快照）。前序帧仍要解——GIF 帧是增量的，画布状态必须顺序推进，
 *   这一点在 `GifDecoder` 的文档里写明了，免得后来者误以为可以随机访问。
 * - **场景采样**：必须比较相邻帧，故全量解码，但选择在**流式回调**里完成
 *   （`FrameSceneSelector` 只保留 `maxFrames + 1` 帧，内存与源长度无关）。
 *   若整段几乎无变化（选中 < 2 帧），**回退为均匀采样**并写明原因——
 *   「场景模式只给 1 帧」对使用者毫无价值，那才是不诚实。
 *
 * ## 边界（明写，不粉饰）
 *
 * - GIF 必须整份读入内存（格式无随机访问），故有输入体积上限；超限时报错并给出
 *   「先转成视频」这类可行动建议，而不是让进程被 OOM 杀掉。
 * - 单帧超预算先缩、缩不动则**丢弃并逐帧说明**；总预算超限时按时间**均匀**裁剪
 *   （丢末尾会让模型完全看不到结尾，那往往正是结论所在）。
 */
export class GifFrameExtractor implements MediaFrameExtractor {
  /** 实现名。 */
  public readonly name = 'gif-decoder';

  /**
   * @param maxInputBytes 源文件体积上限（字节）。
   * @param encoder 帧编码器（长边与单帧字节预算）。
   */
  public constructor(
    private readonly maxInputBytes: number,
    private readonly encoder: FrameEncoder,
  ) {}

  /**
   * 是否支持该媒体大类。
   *
   * @param kind 媒体大类。
   * @returns 仅 `gif` 为 true。
   */
  public supports(kind: MediaKind): boolean {
    return kind === 'gif';
  }

  /**
   * 提取帧。
   *
   * @param request 提取请求。
   * @returns 帧集合 + 精确元数据 + 过程说明；无法提取时 `frames` 为空且 `notes` 说明原因。
   */
  public async extract(request: FrameExtractionRequest): Promise<FrameExtractionResult> {
    const notes: string[] = [];
    const size = await GifFrameExtractor.fileSize(request.absolutePath);
    if (size === undefined) {
      return GifFrameExtractor.failure(
        request.probe,
        `无法读取 ${request.absolutePath} 的文件信息`,
      );
    }
    if (size > this.maxInputBytes) {
      return GifFrameExtractor.failure(
        request.probe,
        `GIF 体积 ${String(size)} 字节，超过上限 ${String(this.maxInputBytes)} 字节。` +
          'GIF 必须整份读入内存解码；请先用 ffmpeg 转成视频再抽取，或调高 media.maxInputBytes。',
      );
    }
    const bytes = await readFile(request.absolutePath);
    const structure = GifDecoder.decode(bytes, {
      skipPixels: true,
      maxFrames: STRUCTURE_FRAME_CAP,
    });
    const probe = GifFrameExtractor.probeOf(structure);
    if (structure.frameCount === 0) {
      return GifFrameExtractor.failure(probe, 'GIF 中没有图像帧（文件可能只含扩展块）');
    }
    const window = GifFrameExtractor.resolveWindow(structure, request);
    if (window.endMs <= window.startMs && structure.frameCount > 1) {
      return GifFrameExtractor.failure(
        probe,
        `采样窗口为空（起点 ${String(window.startMs)}ms ≥ 终点 ${String(window.endMs)}ms，` +
          `总时长 ${String(structure.totalDurationMs)}ms）`,
      );
    }
    const source =
      request.selection.strategy === 'scene'
        ? this.sceneFrames(bytes, structure, request, window, notes)
        : GifFrameExtractor.uniformFrames(bytes, structure, request, window);
    if (source.length === 0) {
      return GifFrameExtractor.failure(
        probe,
        `采样窗口 [${String(window.startMs)}ms, ${String(window.endMs)}ms] 内没有可用帧`,
      );
    }
    const frames = await this.encodeFrames(source, request, notes);
    const budget = MediaFrameBudget.trim(frames, request.selection.maxTotalBytes);
    if (budget.dropped > 0) {
      notes.push(
        `总字节超出上限 ${String(request.selection.maxTotalBytes)}：` +
          `已按时间均匀保留 ${String(budget.frames.length)} 帧、丢弃 ${String(budget.dropped)} 帧`,
      );
    }
    if (structure.damagedFrameCount > 0) {
      notes.push(
        `源中有 ${String(structure.damagedFrameCount)} 帧压缩数据不完整（已按容错语义还原，可能有色块缺失）`,
      );
    }
    return {
      frames: budget.frames,
      probe,
      notes,
      truncated: budget.dropped > 0 || structure.truncated,
    };
  }

  /**
   * 均匀采样：结构扫描定时间点 → 定向解码取像素。
   *
   * @param bytes 源字节。
   * @param structure 结构扫描结果。
   * @param request 提取请求。
   * @param window 采样窗口。
   * @returns 待编码的帧（升序）；窗口内无帧时为空。
   */
  private static uniformFrames(
    bytes: Buffer,
    structure: GifAnimation,
    request: FrameExtractionRequest,
    window: SampleWindow,
  ): EncodableFrame[] {
    const selected = MediaFrameSampler.uniform(
      structure.timeline,
      window.startMs,
      window.endMs,
      request.selection.maxFrames,
    );
    if (selected.length === 0) {
      return [];
    }
    const decode = GifDecoder.decode(bytes, {
      wantedIndices: new Set(selected.map((entry) => entry.sourceIndex)),
      stopAfterIndex: Math.max(...selected.map((entry) => entry.sourceIndex)),
    });
    const byIndex = new Map(decode.frames.map((frame) => [frame.sourceIndex, frame]));
    const frames: EncodableFrame[] = [];
    for (const entry of selected) {
      const decoded = byIndex.get(entry.sourceIndex);
      if (decoded !== undefined) {
        // 时长取**解码帧**的 `delayMs`（来自图形控制扩展，类型上必为数字），而不是采样候选的
        // 可选字段：候选类型里 `delayMs` 是 `number | undefined`（视频路径无此概念），
        // 若在此 `?? 0` 会凭空造出一个「0ms 时长」的假事实。
        frames.push(
          GifFrameExtractor.encodable(
            decoded.sourceIndex,
            entry.timestampMs,
            decoded.delayMs,
            decoded,
          ),
        );
      }
    }
    return frames;
  }

  /**
   * 场景采样：全量流式解码 + 相邻帧变化判定；变化不足时回退均匀。
   *
   * @param bytes 源字节。
   * @param structure 结构扫描结果。
   * @param request 提取请求。
   * @param window 采样窗口。
   * @param notes 说明收集器（原地追加）。
   * @returns 待编码的帧（升序）。
   */
  private sceneFrames(
    bytes: Buffer,
    structure: GifAnimation,
    request: FrameExtractionRequest,
    window: SampleWindow,
    notes: string[],
  ): EncodableFrame[] {
    const selector = new FrameSceneSelector({
      threshold: request.selection.sceneThreshold,
      maxFrames: request.selection.maxFrames,
      minGapMs: SCENE_MIN_GAP_MS,
    });
    const lastIndex = GifFrameExtractor.lastIndexWithin(structure.timeline, window.endMs);
    GifDecoder.decode(bytes, {
      onFrame: (frame) => {
        if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
          selector.consider(frame);
        }
      },
      stopAfterIndex: lastIndex,
    });
    const chosen = selector.selected;
    if (structure.frameCount > 1 && chosen.length < 2) {
      notes.push(
        `场景检测在阈值 ${String(request.selection.sceneThreshold)} 下只命中 ${String(chosen.length)} 帧：` +
          '画面变化不足以支撑场景采样，已回退为均匀采样',
      );
      return GifFrameExtractor.uniformFrames(bytes, structure, request, window);
    }
    notes.push(
      `场景采样：按变化像素占比阈值 ${String(request.selection.sceneThreshold)} 选出 ${String(chosen.length)} 帧`,
    );
    return chosen.map((frame) => ({
      sourceIndex: frame.sourceIndex,
      timestampMs: frame.timestampMs,
      durationMs: frame.delayMs,
      rgba: frame.rgba,
      width: frame.width,
      height: frame.height,
    }));
  }

  /**
   * 逐帧编码（含缩放与超预算丢弃）。
   *
   * @param source 待编码帧（升序）。
   * @param request 提取请求（提供长边与字节预算）。
   * @param notes 说明收集器（原地追加）。
   * @returns 已编码的帧（升序，`index` 连续重编号）。
   */
  private async encodeFrames(
    source: readonly EncodableFrame[],
    request: FrameExtractionRequest,
    notes: string[],
  ): Promise<MediaFrame[]> {
    const frames: MediaFrame[] = [];
    let dropped = 0;
    let shrunk = 0;
    for (const item of source) {
      const outcome = this.encoder.encode({
        rgba: item.rgba,
        width: item.width,
        height: item.height,
      });
      if (!outcome.ok || outcome.bytes === undefined) {
        dropped += 1;
        notes.push(
          `第 ${String(item.sourceIndex)} 帧（t=${String(item.timestampMs)}ms）未交付：${String(outcome.reason)}`,
        );
        continue;
      }
      if (outcome.shrunk) {
        shrunk += 1;
      }
      frames.push({
        index: frames.length,
        timestampMs: item.timestampMs,
        width: outcome.width,
        height: outcome.height,
        durationMs: item.durationMs,
        mediaType: 'image/png',
        bytes: outcome.bytes,
      });
    }
    if (shrunk > 0) {
      notes.push(
        `${String(shrunk)} 帧因超过长边上限 ${String(request.selection.maxDimension)}px ` +
          '或单帧字节上限已等比缩小',
      );
    }
    if (dropped > 0) {
      notes.push(`${String(dropped)} 帧未交付（原因见上）`);
    }
    return frames;
  }

  /**
   * 由解码帧与时间轴条目组装待编码帧。
   *
   * @param sourceIndex 源帧序号。
   * @param timestampMs 起始时间（毫秒）。
   * @param durationMs 显示时长（毫秒）。
   * @param decoded 已解码帧。
   * @returns 待编码帧。
   */
  private static encodable(
    sourceIndex: number,
    timestampMs: number,
    durationMs: number,
    decoded: { readonly rgba: Uint8Array; readonly width: number; readonly height: number },
  ): EncodableFrame {
    return {
      sourceIndex,
      timestampMs,
      durationMs,
      rgba: decoded.rgba,
      width: decoded.width,
      height: decoded.height,
    };
  }

  /**
   * 解析采样窗口（缺省＝整条时间轴）。
   *
   * @param structure 结构扫描结果。
   * @param request 提取请求。
   * @returns 收敛到有效区间的窗口。
   */
  private static resolveWindow(
    structure: GifAnimation,
    request: FrameExtractionRequest,
  ): SampleWindow {
    const total = Math.max(structure.totalDurationMs, 1);
    const startMs = Math.max(0, request.selection.startMs);
    const requested = request.selection.endMs ?? total;
    return { startMs, endMs: Math.min(Math.max(requested, 0), total) };
  }

  /**
   * 找窗口终点之前的最后一个源帧序号（用于限制解码范围）。
   *
   * @param timeline 帧时间轴（升序）。
   * @param endMs 窗口终点（毫秒）。
   * @returns 源帧序号；时间轴为空时为 0。
   */
  private static lastIndexWithin(timeline: readonly GifFrameTiming[], endMs: number): number {
    let last = 0;
    for (const entry of timeline) {
      if (entry.timestampMs <= endMs) {
        last = entry.sourceIndex;
      }
    }
    return last;
  }

  /**
   * 由结构统计构造精确元数据。
   *
   * @param structure 结构扫描结果。
   * @returns 媒体元数据。
   */
  private static probeOf(structure: GifAnimation): MediaProbeInfo {
    const seconds = structure.totalDurationMs / 1000;
    return {
      kind: 'gif',
      container: 'gif',
      codec: 'gif',
      width: structure.width,
      height: structure.height,
      durationMs: structure.totalDurationMs,
      frameCount: structure.frameCount,
      frameRate: seconds > 0 ? structure.frameCount / seconds : undefined,
      animated: structure.frameCount > 1,
    };
  }

  /**
   * 构造「无法提取」的结果（帧为空 + 说明）。
   *
   * @param probe 已探测到的元数据（可能不完整）。
   * @param reason 可行动的原因。
   * @returns 提取结果。
   */
  private static failure(probe: MediaProbeInfo, reason: string): FrameExtractionResult {
    return { frames: [], probe, notes: [reason], truncated: false };
  }

  /**
   * 读取文件大小。
   *
   * @param path 绝对路径。
   * @returns 字节数；读取失败时为 `undefined`。
   */
  private static async fileSize(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  }
}
