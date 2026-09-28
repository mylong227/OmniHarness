import type { MediaProbePort } from '../../ports/media/mediaProbe.js';
import type { MediaProbeInfo } from '../../ports/media/mediaTypes.js';
import { FfprobeJsonParser } from '../../media/ffprobeJsonParser.js';
import type { FfmpegLocator } from './ffmpegLocator.js';
import type { MediaProcessRunner } from './mediaProcessRunner.js';

/** 探测超时（毫秒）：探测必须远快于抽帧，久等即视为不可用。 */
const PROBE_TIMEOUT_MS = 20_000;

/** stdout 上限（ffprobe JSON 通常几 KB；给足但不放任）。 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * ffprobe 元数据探测（权威路径）。
 *
 * 为什么用 `-print_format json`：文本输出格式随版本漂移，而 JSON 字段名稳定，
 * 且 `avg_frame_rate` 这类「分数形式」的字段能原样拿到（`30000/1001` 若在文本里
 * 被四舍五入成 `29.97`，累积到 40 分钟的时长上就是几十帧的误差）。
 *
 * 定位不到 ffprobe 时返回 `undefined`（不抛错）——由 `MediaProbeChain` 决定是否退化到
 * ffmpeg stderr 兜底。**探测失败不是致命错误**：
 * 只要调用方显式给出了采样窗口，抽帧根本不需要时长。
 */
export class FfprobeMediaProbe implements MediaProbePort {
  /** 端口名。 */
  public readonly name = 'ffprobe';

  /**
   * @param locator 二进制定位器（定位结果自带缓存）。
   * @param runner 受控子进程执行器。
   */
  public constructor(
    private readonly locator: FfmpegLocator,
    private readonly runner: MediaProcessRunner,
  ) {}

  /**
   * 探测视频元数据。
   *
   * @param absolutePath 源文件绝对路径。
   * @param signal 会话取消信号（可选）。
   * @returns 元数据；无 ffprobe / 无视频流 / 不可解析时为 `undefined`。
   */
  public async probe(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<MediaProbeInfo | undefined> {
    const location = await this.locator.locate();
    if (location.ffprobePath === undefined) {
      return undefined;
    }
    const outcome = await this.runner.run({
      command: location.ffprobePath,
      args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolutePath],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (outcome.spawnError !== undefined || outcome.timedOut || outcome.exitCode !== 0) {
      return undefined;
    }
    const facts = FfprobeJsonParser.parse(outcome.stdout.toString('utf8'));
    if (facts === undefined) {
      return undefined;
    }
    return {
      kind: 'video',
      container: facts.container ?? 'unknown',
      codec: facts.codec,
      width: facts.width,
      height: facts.height,
      durationMs: facts.durationMs,
      frameCount: facts.frameCount,
      frameRate: facts.frameRate,
      animated: true,
    };
  }
}
