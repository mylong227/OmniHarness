import type { MediaStreamFacts } from './mediaStreamFacts.js';

/** 输入行：`Input #0, mov,mp4,..., from 'x.mp4':`（格式名本身含逗号，故用「到 , from 为止」的贪婪边界）。 */
const INPUT_LINE = /^Input #\d+,\s*(.+?),\s*from\s/;
/** 时长行：`Duration: 00:00:02.30, start: ...`。 */
const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
/** 视频流行（同一行后续还要取编码 / 尺寸 / 帧率）。 */
const VIDEO_STREAM_LINE = /Stream #\d+:\d+.*?:\s*Video:\s*([A-Za-z0-9_]+)/;
/** 尺寸（要求前后是分隔符，避免命中 `0x31637661` 这类十六进制串）。 */
const DIMENSIONS = /(?:^|[,\s])(\d{2,5})x(\d{2,5})(?=[,\s[]|$)/;
/** 帧率：`10 fps`。 */
const FRAME_RATE = /(\d+(?:\.\d+)?)\s*fps\b/;

/**
 * ffmpeg stderr 解析器（`ffmpeg -i <file>` 的输入摘要）。
 *
 * ## 为什么需要这条兜底
 *
 * 权威探测走 ffprobe（JSON），但 ffprobe 与 ffmpeg 是**两个二进制**：现实中大量环境
 * （含本仓库沙箱实测的 `imageio-ffmpeg` 发行包）只带 ffmpeg 而不带 ffprobe。
 * 若没有兜底，「有 ffmpeg 也不能抽帧」——因为均匀采样必须知道时长才能算采样间隔。
 *
 * ffmpeg 在 `-i` 时把同样的元数据打印到 stderr，格式多年稳定，是公认的第二来源。
 * 本类只做**保守解析**：任一字段读不出就给 `undefined`，**绝不用默认值冒充**
 * （时长猜错会让全部帧时间戳错位，比"未知"更糟）。
 */
export class FfmpegStderrParser {
  /**
   * 解析 ffmpeg 的输入摘要文本。
   *
   * @param text ffmpeg 的 stderr 文本。
   * @returns 视频流事实；连输入行都没有时为 `undefined`。
   */
  public static parse(text: string): MediaStreamFacts | undefined {
    const lines = text.split(/\r?\n/);
    const inputLine = lines.find((line) => INPUT_LINE.test(line));
    if (inputLine === undefined) {
      return undefined;
    }
    const container = INPUT_LINE.exec(inputLine)?.[1];
    const durationMs = FfmpegStderrParser.parseDuration(lines);
    const videoLine = FfmpegStderrParser.findVideoLine(lines);
    const codec = videoLine === undefined ? undefined : VIDEO_STREAM_LINE.exec(videoLine)?.[1];
    const dimensions = videoLine === undefined ? null : DIMENSIONS.exec(videoLine);
    const frameRate =
      videoLine === undefined ? undefined : Number(FRAME_RATE.exec(videoLine)?.[1] ?? Number.NaN);
    return {
      container,
      codec,
      width: dimensions === null ? undefined : Number(dimensions[1]),
      height: dimensions === null ? undefined : Number(dimensions[2]),
      durationMs,
      frameCount: undefined,
      frameRate: Number.isFinite(frameRate) && (frameRate ?? 0) > 0 ? frameRate : undefined,
    };
  }

  /**
   * 取第一行时长。
   *
   * @param lines stderr 行数组。
   * @returns 时长（毫秒）；未找到时为 `undefined`。
   */
  private static parseDuration(lines: readonly string[]): number | undefined {
    for (const line of lines) {
      const match = DURATION_LINE.exec(line);
      if (match === null) {
        continue;
      }
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
    return undefined;
  }

  /**
   * 找第一条视频流行。
   *
   * @param lines stderr 行数组。
   * @returns 视频流行；没有视频流时为 `undefined`。
   */
  private static findVideoLine(lines: readonly string[]): string | undefined {
    return lines.find((line) => VIDEO_STREAM_LINE.test(line));
  }
}
