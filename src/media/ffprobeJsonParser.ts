import type { MediaStreamFacts } from './mediaStreamFacts.js';

/** 帧率分数字符串（如 `30000/1001`）。 */
const FRACTION = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/;

/** ffprobe JSON 里流对象的形状（只声明用得到的字段，其余忽略）。 */
interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly r_frame_rate?: string;
  readonly nb_frames?: string;
  readonly duration?: string;
  readonly nb_read_frames?: string;
}

/** ffprobe JSON 顶层形状。 */
interface FfprobeDocument {
  readonly streams?: readonly FfprobeStream[];
  readonly format?: {
    readonly format_name?: string;
    readonly duration?: string;
    readonly nb_streams?: number;
  };
}

/**
 * ffprobe JSON 解析器（`-print_format json -show_format -show_streams` 的输出）。
 *
 * ## 为什么走 ffprobe 而不是自己解析容器
 *
 * mp4/mkv/webm 的时长、帧率、帧数分布在不同 box / EBML 元素里，且存在 VFR、编辑列表、
 * 分片 mp4 等大量变体——自己解析要维护一整套容器知识，收益为零。ffprobe 是这些信息的
 * **权威来源**，且以 JSON 给出稳定字段。本类只做「JSON → 内部事实」的确定性映射。
 *
 * 解析失败（非 JSON / 无视频流）返回 `undefined`：调用方据此走 stderr 兜底或如实报未知，
 * 而不是拿一个默认时长蒙混过去 —— 时长错了，抽出来的帧时间戳全错。
 */
export class FfprobeJsonParser {
  /**
   * 解析 ffprobe JSON 文本。
   *
   * @param text ffprobe 的 stdout 文本。
   * @returns 视频流事实；无视频流或不可解析时为 `undefined`。
   */
  public static parse(text: string): MediaStreamFacts | undefined {
    const document = FfprobeJsonParser.readDocument(text);
    if (document === undefined) {
      return undefined;
    }
    const stream = document.streams?.find((candidate) => candidate.codec_type === 'video');
    if (stream === undefined) {
      return undefined;
    }
    const durationMs = FfprobeJsonParser.secondsToMs(document.format?.duration ?? stream.duration);
    const frameRate =
      FfprobeJsonParser.fractionToNumber(stream.avg_frame_rate) ??
      FfprobeJsonParser.fractionToNumber(stream.r_frame_rate);
    return {
      container: document.format?.format_name,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      durationMs,
      frameCount: FfprobeJsonParser.frameCount(stream, durationMs, frameRate),
      frameRate,
    };
  }

  /**
   * 读取并校验 JSON 文档。
   *
   * @param text 原始文本。
   * @returns 文档对象；不可解析时为 `undefined`。
   */
  private static readDocument(text: string): FfprobeDocument | undefined {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
      }
      return parsed as FfprobeDocument;
    } catch {
      return undefined;
    }
  }

  /**
   * 取帧数：优先 `nb_frames`，否则由时长 × 帧率推算。
   *
   * @param stream 流对象。
   * @param durationMs 时长（毫秒）。
   * @param frameRate 帧率。
   * @returns 帧数；无法确定时为 `undefined`。
   */
  private static frameCount(
    stream: FfprobeStream,
    durationMs: number | undefined,
    frameRate: number | undefined,
  ): number | undefined {
    const declared = Number(stream.nb_frames ?? stream.nb_read_frames ?? '');
    if (Number.isFinite(declared) && declared > 0) {
      return Math.round(declared);
    }
    if (durationMs === undefined || frameRate === undefined) {
      return undefined;
    }
    return Math.max(1, Math.round((durationMs / 1000) * frameRate));
  }

  /**
   * 秒字符串转毫秒。
   *
   * @param value 秒数字符串（如 `2.300000`）。
   * @returns 毫秒；不可解析时为 `undefined`。
   */
  private static secondsToMs(value: string | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }

  /**
   * 帧率分数字符串转数字。
   *
   * @param value 形如 `30000/1001` 或 `25` 的字符串。
   * @returns 帧率；不可解析或分母为 0 时为 `undefined`。
   */
  private static fractionToNumber(value: string | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    const fraction = FRACTION.exec(value.trim());
    if (fraction === null) {
      const plain = Number(value);
      return Number.isFinite(plain) && plain > 0 ? plain : undefined;
    }
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return undefined;
    }
    const ratio = numerator / denominator;
    return ratio > 0 ? ratio : undefined;
  }
}
