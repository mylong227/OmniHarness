import type { MediaProbePort } from '../../ports/media/mediaProbe.js';
import type { MediaProbeInfo } from '../../ports/media/mediaTypes.js';
import { FfmpegStderrParser } from '../../media/ffmpegStderrParser.js';
import type { FfmpegLocator } from './ffmpegLocator.js';
import type { MediaProcessRunner } from './mediaProcessRunner.js';

/** 探测超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 20_000;

/** stderr 上限（输入摘要通常几 KB）。 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 基于 `ffmpeg -i` 输出摘要的元数据探测（兜底路径）。
 *
 * ## 为什么必须有这条兜底
 *
 * 现实中「装了 ffmpeg 但没装 ffprobe」是**常态**——包括大量发行版打包方式与
 * Python 生态的 `imageio-ffmpeg` 之类的单二进制分发（本仓沙箱实测即是如此）。
 * 若探测只认 ffprobe，那么「有 ffmpeg 却不能抽帧」——因为均匀采样需要时长来算间隔。
 *
 * ffmpeg 在 `-i` 时会把容器、时长、流信息打印到 stderr；这是公认的第二来源，
 * 格式多年稳定（见 `FfmpegStderrParser` 的解析注释与真实样本测试）。
 *
 * ## 两个容易写错的点
 *
 * 1. **退出码不是 0**：`ffmpeg -i x.mp4` 必然以 1 退出（"At least one output file must be
 *    specified"），把它当失败会让这条兜底永不可用。故此处只判 `spawnError` / 超时 / 是否解析出输入行。
 * 2. **stderr 才是输出**：stdout 此时为空，读错流会得到「永远是空」的假象。
 */
export class FfmpegStderrMediaProbe implements MediaProbePort {
  /** 端口名。 */
  public readonly name = 'ffmpeg-stderr';

  /**
   * @param locator 二进制定位器（复用同一个缓存结果）。
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
   * @returns 元数据；无 ffmpeg / 不是可识别媒体时为 `undefined`。
   */
  public async probe(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<MediaProbeInfo | undefined> {
    const location = await this.locator.locate();
    if (location.ffmpegPath === undefined) {
      return undefined;
    }
    const outcome = await this.runner.run({
      command: location.ffmpegPath,
      args: ['-hide_banner', '-nostdin', '-i', absolutePath],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (outcome.spawnError !== undefined || outcome.timedOut) {
      return undefined;
    }
    const facts = FfmpegStderrParser.parse(outcome.stderr);
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
