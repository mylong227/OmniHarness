import { dirname, join } from 'node:path';
import type { MediaProcessRunner } from './mediaProcessRunner.js';
import type { PathBinaryResolver } from './pathBinaryResolver.js';

/** 定位结果。 */
export interface FfmpegLocation {
  /** ffmpeg 可执行文件路径；不可用时为 `undefined`。 */
  readonly ffmpegPath: string | undefined;
  /** ffprobe 可执行文件路径；不可用时为 `undefined`（探测会退化到 stderr 兜底）。 */
  readonly ffprobePath: string | undefined;
  /** ffmpeg 版本号（如 `7.1`）；未定位到时为 `undefined`。 */
  readonly version: string | undefined;
  /** 人类可读的定位说明（**无论成功失败都有值**，失败时即「为什么不可用 + 怎么办」）。 */
  readonly reason: string;
}

/** 定位器依赖。 */
export interface FfmpegLocatorOptions {
  /** 显式配置的 ffmpeg 路径（最高优先级；配错即报错，不静默回落）。 */
  readonly configuredFfmpegPath: string | undefined;
  /** 显式配置的 ffprobe 路径。 */
  readonly configuredFfprobePath: string | undefined;
  /** 环境变量表（读 `OMNI_FFMPEG_PATH` / `OMNI_FFPROBE_PATH`）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 二进制解析器（PATH + 附加目录）。 */
  readonly resolver: PathBinaryResolver;
  /** 受控子进程执行器（验证可执行性）。 */
  readonly runner: MediaProcessRunner;
  /** 验证超时（毫秒）。 */
  readonly verifyTimeoutMs: number;
}

/** 环境变量名（与配置项并存：配置优先，环境变量次之）。 */
const ENV_FFMPEG_PATH = 'OMNI_FFMPEG_PATH';
const ENV_FFPROBE_PATH = 'OMNI_FFPROBE_PATH';

/** 版本号提取。 */
const FFMPEG_VERSION = /ffmpeg version\s+(\S+)/;
const FFPROBE_VERSION = /ffprobe version\s+(\S+)/;

/**
 * ffmpeg / ffprobe 定位器。
 *
 * ## 为什么需要它（而不是「假设 PATH 里有 ffmpeg」）
 *
 * 视频抽帧是**能力有条件的**：GIF 路径无第三方依赖恒可用，视频路径必须有 ffmpeg。
 * 「有 ffmpeg 才能用」这件事必须在工具的描述与错误里说清楚，否则模型会反复调用一个
 * 必然失败的工具（「声明了但跑不通」比「没有这个工具」更伤 agent 行为）。
 * 本类把「找 + 验证 + 说清为什么不行」收在一个地方，定位结果**带缓存**：
 * 一次调用最多验证一次，避免每次抽帧都多起两个进程。
 *
 * ## 优先级（顺序即语义）
 *
 * 1. 显式配置（`media.ffmpegPath`）——**配错即报错**：若它不可执行，直接判定不可用，
 *    绝不静默改用 PATH 里的另一个版本（否则「我明明指向了自建版本」会被无声推翻）。
 * 2. 环境变量（`OMNI_FFMPEG_PATH`）。
 * 3. PATH + 附加搜索目录。
 * 4. ffprobe 额外尝试「与 ffmpeg 同目录」——两者通常成套安装。
 *
 * 定位到的候选都要**跑一次 `-version`** 才算数：存在 ≠ 可执行（权限、架构、损坏）。
 */
export class FfmpegLocator {
  /** 定位结果缓存（含 promise，避免并发重复定位）。 */
  private cached: Promise<FfmpegLocation> | undefined;

  /**
   * @param options 定位依赖。
   */
  public constructor(private readonly options: FfmpegLocatorOptions) {}

  /**
   * 定位并验证（结果缓存，多次调用只做一次）。
   *
   * @returns 定位结果（失败时 `reason` 给出原因与解决办法）。
   */
  public locate(): Promise<FfmpegLocation> {
    this.cached ??= this.compute();
    return this.cached;
  }

  /**
   * 实际执行定位。
   *
   * @returns 定位结果。
   */
  private async compute(): Promise<FfmpegLocation> {
    const configured = this.options.configuredFfmpegPath;
    const version = await this.verify(configured, FFMPEG_VERSION);
    if (configured !== undefined && version === undefined) {
      return {
        ffmpegPath: undefined,
        ffprobePath: undefined,
        version: undefined,
        reason:
          `配置的 ffmpeg 路径不可用：${configured}（无法执行或不是 ffmpeg）。` +
          '请修正 media.ffmpegPath，或清空该配置以改用 PATH 自动查找。',
      };
    }
    const ffmpegPath =
      version === undefined ? await this.search('ffmpeg', FFMPEG_VERSION) : configured;
    if (ffmpegPath === undefined) {
      return {
        ffmpegPath: undefined,
        ffprobePath: undefined,
        version: undefined,
        reason:
          '未找到本机 ffmpeg：视频抽帧需要 ffmpeg（动画 GIF 不需要）。' +
          '请安装 ffmpeg 并把其 bin 目录加入 PATH，或配置 media.ffmpegPath / ' +
          `环境变量 ${ENV_FFMPEG_PATH} 指向可执行文件。`,
      };
    }
    const ffprobePath = await this.locateFfprobe(ffmpegPath);
    return {
      ffmpegPath,
      ffprobePath,
      version: version ?? (await this.verify(ffmpegPath, FFMPEG_VERSION)),
      reason:
        `已定位 ffmpeg：${ffmpegPath}` +
        (ffprobePath === undefined
          ? '（未找到 ffprobe，元数据探测将退化到 ffmpeg 输出解析）'
          : `，ffprobe：${ffprobePath}`),
    };
  }

  /**
   * 定位 ffprobe（配置 → 环境变量 → PATH → ffmpeg 同目录）。
   *
   * @param ffmpegPath 已定位到的 ffmpeg 路径（用于尝试同目录）。
   * @returns ffprobe 路径；找不到时为 `undefined`。
   */
  private async locateFfprobe(ffmpegPath: string): Promise<string | undefined> {
    const configured = this.options.configuredFfprobePath;
    if (configured !== undefined) {
      const ok = await this.verify(configured, FFPROBE_VERSION);
      // 显式配置不可用同样不静默回落：探测会退回 stderr 兜底，但配置错误必须被看见。
      return ok === undefined ? undefined : configured;
    }
    const fromEnv = this.options.env[ENV_FFPROBE_PATH];
    if (fromEnv !== undefined) {
      const ok = await this.verify(fromEnv, FFPROBE_VERSION);
      if (ok !== undefined) {
        return fromEnv;
      }
    }
    const fromPath = await this.search('ffprobe', FFPROBE_VERSION);
    if (fromPath !== undefined) {
      return fromPath;
    }
    const sibling = FfmpegLocator.siblingProbePath(ffmpegPath);
    return sibling !== undefined && (await this.verify(sibling, FFPROBE_VERSION)) !== undefined
      ? sibling
      : undefined;
  }

  /**
   * 在解析器给出的目录里搜索并验证一个候选。
   *
   * @param name 可执行文件名。
   * @param pattern 版本号提取正则（用于确认「确实是那个工具」）。
   * @returns 路径；未找到或验证失败时为 `undefined`。
   */
  private async search(name: string, pattern: RegExp): Promise<string | undefined> {
    const candidate = this.options.resolver.resolve(name);
    if (candidate === undefined) {
      return undefined;
    }
    return (await this.verify(candidate, pattern)) === undefined ? undefined : candidate;
  }

  /**
   * 验证候选可执行并取版本号。
   *
   * @param candidate 候选路径（`undefined` 直接判定失败）。
   * @param pattern 版本号提取正则。
   * @returns 版本号；不可执行 / 启动失败 / 版本不匹配时为 `undefined`。
   */
  private async verify(
    candidate: string | undefined,
    pattern: RegExp,
  ): Promise<string | undefined> {
    if (candidate === undefined || candidate === '') {
      return undefined;
    }
    const outcome = await this.options.runner.run({
      command: candidate,
      args: ['-hide_banner', '-version'],
      timeoutMs: this.options.verifyTimeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (outcome.spawnError !== undefined || outcome.timedOut || outcome.exitCode !== 0) {
      return undefined;
    }
    const text = `${outcome.stdout.toString('utf8')}\n${outcome.stderr}`;
    return pattern.exec(text)?.[1];
  }

  /**
   * 推一个「与 ffmpeg 同目录」的 ffprobe 候选路径。
   *
   * @param ffmpegPath 已定位到的 ffmpeg 路径。
   * @returns 候选路径；无法推导时为 `undefined`。
   */
  private static siblingProbePath(ffmpegPath: string): string | undefined {
    const directory = dirname(ffmpegPath);
    if (directory === '' || directory === '.') {
      return undefined;
    }
    const suffix = /\.exe$/i.test(ffmpegPath) ? '.exe' : '';
    return join(directory, `ffprobe${suffix}`);
  }
}
