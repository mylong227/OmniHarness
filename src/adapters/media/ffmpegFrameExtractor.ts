import { ImageStreamSplitter } from '../../media/imageStreamSplitter.js';
import { MediaFrameBudget } from '../../media/frameEncoder.js';
import { MediaFrameSampler } from '../../media/mediaFrameSampler.js';
import { ImageProbe } from '../../util/imageProbe.js';
import type {
  FrameExtractionRequest,
  FrameExtractionResult,
  MediaFrameExtractor,
} from '../../ports/media/frameExtractor.js';
import type { MediaFrame, MediaKind, MediaProbeInfo } from '../../ports/media/mediaTypes.js';
import type { MediaProbePort } from '../../ports/media/mediaProbe.js';
import type { FfmpegLocator } from './ffmpegLocator.js';
import type { MediaProcessOutcome, MediaProcessRunner } from './mediaProcessRunner.js';
import type { VideoFrameFormat } from '../../ports/media/mediaTypes/videoFrameFormat.js';

export type { VideoFrameFormat } from '../../ports/media/mediaTypes/videoFrameFormat.js';

/** showinfo 的帧信息行（真实输出见 `tests/unit/frameTimestampParser.test.ts` 的样本）。 */
const SHOWINFO_ENTRY = /(?:^|\s)n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:(\S+)/g;

/** stderr 上限由执行器内部统一设（`SpawnMediaProcessRunner`，256 KiB），此处不再重复声明。 */

/** 构造器参数。 */
export interface FfmpegFrameExtractorOptions {
  /** 二进制定位器（结果缓存）。 */
  readonly locator: FfmpegLocator;
  /** 受控子进程执行器。 */
  readonly runner: MediaProcessRunner;
  /** 元数据探测端口（仅在**需要时长**时使用）。 */
  readonly probe: MediaProbePort;
  /** 帧输出格式。 */
  readonly videoFormat: VideoFrameFormat;
  /** JPEG 质量（2–31，数值越小越清晰、体积越大）。 */
  readonly jpegQuality: number;
}

/**
 * 视频帧提取器（基于本机 ffmpeg）。
 *
 * ## 为什么是「一次进程拿全部帧」而不是「一帧一次进程」
 *
 * 一帧一次 `-ss <t> -frames:v 1` 需要每次都重新 seek + 解到关键帧，8 帧就是 8 次启动
 * （每次几十到几百毫秒，还要重复解同一段）。标准做法是**一次解码、按条件筛帧**：
 * `select` 过滤器在解码流水线里完成筛选，`image2pipe` 把结果连续吐到 stdout。
 *
 * ## 两个滤镜串的语义
 *
 * - 均匀：`select='isnan(prev_selected_t)+gte(t-prev_selected_t\,INTERVAL)'`
 *   —— 第一帧必取，其后每超过一个间隔取一帧。间隔 = 窗口时长 / 帧数预算。
 * - 场景：`select='gt(scene\,THRESHOLD)'` —— ffmpeg 内置的**场景分数**（变化像素占比），
 *   与 GIF 侧 `FrameSceneSelector` 同一语义，故 `sceneThreshold` 对两条路含义一致。
 *
 * 前缀 `scale='min(D\,iw)':'min(D\,ih)':force_original_aspect_ratio=decrease` 限定长边；
 * 末尾 `showinfo` 把每帧的 `pts_time` 打到 stderr —— 时序信息必须来自 ffmpeg 实际给出的帧
 * （而不是我们自己推算的"第 k 个目标时间"），否则模型看到的时刻会是假的。
 *
 * ## 参数传递的关键：直接给 argv，不经 shell
 *
 * 滤镜串里满是 `,` `'` `(` `)`，走 shell 会被二次解释成命令分隔与重定向。
 * 本实现把整条滤镜串作为**一个 argv 元素**传给 `spawn`，不做任何 shell 转义，
 * 也因此不会出现「本地能跑、换个 shell 就炸」的差异。
 */
export class FfmpegFrameExtractor implements MediaFrameExtractor {
  /** 实现名。 */
  public readonly name = 'ffmpeg';

  /**
   * @param options 定位器、执行器、探测端口与输出格式。
   */
  public constructor(private readonly options: FfmpegFrameExtractorOptions) {}

  /**
   * 是否支持该媒体大类。
   *
   * @param kind 媒体大类。
   * @returns 仅 `video` 为 true。
   */
  public supports(kind: MediaKind): boolean {
    return kind === 'video';
  }

  /**
   * 提取视频帧。
   *
   * @param request 提取请求。
   * @returns 帧集合 + 元数据 + 过程说明；无 ffmpeg / 窗口非法 / 无帧可出时 `frames` 为空且 `notes` 说明原因。
   */
  public async extract(request: FrameExtractionRequest): Promise<FrameExtractionResult> {
    const notes: string[] = [];
    const location = await this.options.locator.locate();
    if (location.ffmpegPath === undefined) {
      return { frames: [], probe: request.probe, notes: [location.reason], truncated: false };
    }
    const prepared = await this.prepare(request, notes);
    if ('failure' in prepared) {
      return { frames: [], probe: prepared.probe, notes: [prepared.failure], truncated: false };
    }
    const outcome = await this.runFfmpeg(location.ffmpegPath, request, prepared);
    if (outcome.spawnError !== undefined) {
      return {
        frames: [],
        probe: prepared.probe,
        notes: [`ffmpeg 启动失败：${outcome.spawnError}`],
        truncated: false,
      };
    }
    if (outcome.timedOut) {
      return {
        frames: [],
        probe: prepared.probe,
        notes: [
          `ffmpeg 在 ${String(request.timeoutMs)}ms 内未完成，已被终止。` +
            '可缩小采样窗口（start_ms/end_ms）、减少 max_frames，或提高 media.timeoutMs。',
        ],
        truncated: false,
      };
    }
    if (outcome.truncated) {
      notes.push(`ffmpeg 输出超过上层缓冲上限，末尾帧可能不完整（已丢弃无法解析的尾部数据）`);
    }
    const format = this.options.videoFormat;
    const raw = ImageStreamSplitter.split(outcome.stdout, format === 'jpeg' ? 'jpeg' : 'png');
    if (raw.length === 0) {
      return {
        frames: [],
        probe: prepared.probe,
        notes: [...notes, FfmpegFrameExtractor.explainEmpty(outcome)],
        truncated: false,
      };
    }
    const timestamps = FfmpegFrameExtractor.timestamps(
      outcome.stderr,
      raw.length,
      prepared.startMs,
      prepared.intervalMs,
    );
    const frames = FfmpegFrameExtractor.materialize(raw, timestamps, format, request, notes);
    // 总预算裁剪与 GIF 路径**共用同一实现**（`MediaFrameBudget`）：
    // 两条路各写一份"怎么丢帧"必然漂移，而漂移的表现是「同样参数的视频与 GIF 结果不一致」。
    const budget = MediaFrameBudget.trim(frames, request.selection.maxTotalBytes);
    if (budget.dropped > 0) {
      notes.push(
        `总字节超出上限 ${String(request.selection.maxTotalBytes)}：` +
          `已按时间均匀保留 ${String(budget.frames.length)} 帧、丢弃 ${String(budget.dropped)} 帧`,
      );
    }
    return {
      frames: budget.frames,
      probe: prepared.probe,
      notes,
      truncated: budget.dropped > 0 || outcome.truncated,
    };
  }

  /**
   * 准备阶段：确定探测结果、采样窗口与滤镜串。
   *
   * @param request 提取请求。
   * @param notes 说明收集器（原地追加）。
   * @returns 就绪参数；不可继续时返回 `failure`。
   */
  private async prepare(
    request: FrameExtractionRequest,
    notes: string[],
  ): Promise<
    | {
        readonly probe: MediaProbeInfo;
        readonly startMs: number;
        readonly endMs: number | undefined;
        readonly intervalMs: number;
        readonly filter: string;
        readonly frameLimit: number;
      }
    | { readonly failure: string; readonly probe: MediaProbeInfo }
  > {
    const needsDuration =
      request.selection.strategy === 'uniform' &&
      request.selection.endMs === undefined &&
      request.probe.durationMs === undefined;
    const probed = needsDuration
      ? await this.options.probe.probe(request.absolutePath, request.signal)
      : undefined;
    const probe = FfmpegFrameExtractor.mergeProbe(request.probe, probed);
    const startMs = Math.max(0, request.selection.startMs);
    let endMs = request.selection.endMs;
    if (endMs === undefined && request.selection.strategy === 'uniform') {
      if (probe.durationMs === undefined) {
        return {
          failure:
            '无法确定视频时长，均匀采样无法计算间隔：请显式给出 end_ms，' +
            '或安装/配置 ffprobe（media.ffprobePath）后重试。',
          probe,
        };
      }
      endMs = probe.durationMs;
    }
    if (probe.durationMs !== undefined && endMs !== undefined) {
      endMs = Math.min(endMs, probe.durationMs);
    }
    if (endMs !== undefined && endMs <= startMs) {
      return {
        failure:
          `采样窗口为空（起点 ${String(startMs)}ms ≥ 终点 ${String(endMs)}ms，` +
          `源时长 ${probe.durationMs === undefined ? '未知' : `${String(probe.durationMs)}ms`}）`,
        probe,
      };
    }
    const intervalMs =
      endMs === undefined
        ? 0
        : FfmpegFrameExtractor.intervalMs(startMs, endMs, request.selection.maxFrames);
    if (endMs !== undefined) {
      notes.push(
        `采样窗口 ${(startMs / 1000).toFixed(3)}s–${(endMs / 1000).toFixed(3)}s，` +
          `目标 ${String(request.selection.maxFrames)} 帧`,
      );
    }
    return {
      probe,
      startMs,
      endMs,
      intervalMs,
      filter: this.buildFilter(request, intervalMs),
      frameLimit: request.selection.maxFrames,
    };
  }

  /**
   * 组装滤镜串（select → scale → showinfo）。
   *
   * @param request 提取请求。
   * @param intervalMs 均匀采样间隔（毫秒；场景策略忽略）。
   * @returns 滤镜串（作为单个 argv 元素传递）。
   */
  private buildFilter(request: FrameExtractionRequest, intervalMs: number): string {
    const maxDimension = request.selection.maxDimension;
    const selector =
      request.selection.strategy === 'scene'
        ? `select='gt(scene\\,${request.selection.sceneThreshold})'`
        : `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${(intervalMs / 1000).toFixed(4)})'`;
    const scale = `scale='min(${String(maxDimension)}\\,iw)':'min(${String(maxDimension)}\\,ih)':force_original_aspect_ratio=decrease`;
    return `${selector},${scale},showinfo`;
  }

  /**
   * 执行 ffmpeg 抽帧。
   *
   * @param ffmpegPath ffmpeg 可执行文件路径。
   * @param request 提取请求。
   * @param prepared 就绪参数。
   * @returns 进程执行结果。
   */
  private runFfmpeg(
    ffmpegPath: string,
    request: FrameExtractionRequest,
    prepared: {
      readonly startMs: number;
      readonly endMs: number | undefined;
      readonly filter: string;
      readonly frameLimit: number;
    },
  ): Promise<MediaProcessOutcome> {
    const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
    if (prepared.startMs > 0) {
      args.push('-ss', (prepared.startMs / 1000).toFixed(3));
    }
    if (prepared.endMs !== undefined) {
      args.push('-t', ((prepared.endMs - prepared.startMs) / 1000).toFixed(3));
    }
    args.push('-i', request.absolutePath, '-vf', prepared.filter);
    args.push('-frames:v', String(prepared.frameLimit), '-fps_mode', 'passthrough');
    args.push('-f', 'image2pipe', '-vcodec', this.options.videoFormat === 'jpeg' ? 'mjpeg' : 'png');
    if (this.options.videoFormat === 'jpeg') {
      args.push('-q:v', String(this.options.jpegQuality));
    }
    args.push('-');
    return this.options.runner.run({
      command: ffmpegPath,
      args,
      timeoutMs: request.timeoutMs,
      // 缓冲上限刻意给得比总预算宽：单帧超限由逐帧判定处理（附原因），
      // 这里的上限只用于兜住「ffmpeg 不守 -frames:v」这种异常。
      // stderr 另有执行器内部的固定上限（`SpawnMediaProcessRunner`，256 KiB）——
      // `showinfo` 每帧一行、几十字节，即使 32 帧也远在限内，故此处不再单独设限。
      maxOutputBytes: request.selection.maxTotalBytes * 2 + 1024 * 1024,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  }

  /**
   * 把原始图片字节组装成帧（含单帧字节上限判定）。
   *
   * @param raw 已切分的图片字节（按时间顺序）。
   * @param timestamps 每帧的时间戳（毫秒；长度不足时按间隔补算）。
   * @param format 图片格式。
   * @param request 提取请求。
   * @param notes 说明收集器（原地追加）。
   * @returns 帧集合（`index` 连续编号）。
   */
  private static materialize(
    raw: readonly Buffer[],
    timestamps: readonly number[],
    format: VideoFrameFormat,
    request: FrameExtractionRequest,
    notes: string[],
  ): MediaFrame[] {
    const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const frames: MediaFrame[] = [];
    let dropped = 0;
    for (let order = 0; order < raw.length; order += 1) {
      const bytes = raw[order] as Buffer;
      const timestampMs = timestamps[order] ?? 0;
      if (bytes.byteLength > request.selection.maxFrameBytes) {
        dropped += 1;
        notes.push(
          `第 ${String(order)} 帧（t=${String(timestampMs)}ms）${String(bytes.byteLength)} 字节 ` +
            `超过单帧上限 ${String(request.selection.maxFrameBytes)}，未交付`,
        );
        continue;
      }
      // 尺寸从图片头直接读（`ImageProbe` 已在仓，支持 png/jpeg）：
      // 报 0 会让模型以为"这帧是空的"，而不报尺寸又会让它难以判断画面比例。
      const info = ImageProbe.probe(bytes);
      frames.push({
        index: frames.length,
        timestampMs,
        width: info?.width ?? 0,
        height: info?.height ?? 0,
        durationMs: undefined,
        mediaType,
        bytes,
      });
    }
    if (dropped > 0) {
      notes.push(`${String(dropped)} 帧因单帧字节超限未交付（原因见上）`);
    }
    return frames;
  }

  /**
   * 解析 showinfo 输出的帧时间戳；不足时按采样间隔补算。
   *
   * @param stderr ffmpeg 的 stderr 文本。
   * @param frameCount 实际帧数。
   * @param startMs 窗口起点（毫秒）。
   * @param intervalMs 均匀采样间隔（毫秒；场景策略为 0）。
   * @returns 每帧时间戳（毫秒，升序）。
   */
  private static timestamps(
    stderr: string,
    frameCount: number,
    startMs: number,
    intervalMs: number,
  ): number[] {
    const parsed: number[] = [];
    for (const match of stderr.matchAll(SHOWINFO_ENTRY)) {
      const seconds = Number(match[3]);
      if (Number.isFinite(seconds)) {
        parsed.push(Math.round(startMs + seconds * 1000));
      }
    }
    if (parsed.length >= frameCount) {
      return parsed.slice(0, frameCount);
    }
    // 时间戳缺失（ffmpeg 输出被截断 / 版本差异）：按采样间隔补算，
    // 但**不掩盖**——缺失本身在 notes 里由调用方按 `truncated` 体现。
    return Array.from({ length: frameCount }, (_unused, order) =>
      Math.round(startMs + order * intervalMs),
    );
  }

  /**
   * 采样间隔（毫秒）。
   *
   * @param startMs 窗口起点（毫秒）。
   * @param endMs 窗口终点（毫秒）。
   * @param maxFrames 帧数预算。
   * @returns 间隔（毫秒，至少 1ms）。
   */
  private static intervalMs(startMs: number, endMs: number, maxFrames: number): number {
    return Math.max(
      1,
      Math.round(MediaFrameSampler.intervalSeconds(startMs, endMs, maxFrames) * 1000),
    );
  }

  /**
   * 合并「嗅探得到的元数据」与「探测得到的元数据」（探测优先，缺失字段互补）。
   *
   * @param sniffed 嗅探结果（含大类与容器）。
   * @param probed 探测结果（可能为 `undefined`）。
   * @returns 合并后的元数据。
   */
  private static mergeProbe(
    sniffed: MediaProbeInfo,
    probed: MediaProbeInfo | undefined,
  ): MediaProbeInfo {
    if (probed === undefined) {
      return sniffed;
    }
    return {
      kind: sniffed.kind,
      container: probed.container ?? sniffed.container,
      codec: probed.codec ?? sniffed.codec,
      width: probed.width ?? sniffed.width,
      height: probed.height ?? sniffed.height,
      durationMs: probed.durationMs ?? sniffed.durationMs,
      frameCount: probed.frameCount ?? sniffed.frameCount,
      frameRate: probed.frameRate ?? sniffed.frameRate,
      animated: true,
    };
  }

  /**
   * 把「一帧都没出」翻译成可行动的原因（ffmpeg 的 stderr 尾部是关键证据）。
   *
   * @param outcome 进程执行结果。
   * @returns 说明文本。
   */
  private static explainEmpty(outcome: MediaProcessOutcome): string {
    const lines = outcome.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /error|invalid|failed|no such|not found|does not/i.test(line));
    const detail = lines.slice(-3).join(' | ');
    return (
      `ffmpeg 未产出任何帧（退出码 ${String(outcome.exitCode)}）` +
      (detail === '' ? '' : `：${detail}`) +
      (outcome.timedOut ? '（已超时终止）' : '')
    );
  }
}
