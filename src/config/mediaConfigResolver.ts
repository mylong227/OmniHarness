import type { VideoFrameFormat } from '../adapters/media/ffmpegFrameExtractor.js';

/** 媒体分析配置（`OmniHarnessConfig.media`，全部可选，缺省用下表的默认值）。 */
export interface MediaAnalysisConfig {
  /** ffmpeg 可执行文件路径（最高优先级；配错即报错，不静默回落）。 */
  readonly ffmpegPath?: string | undefined;
  /** ffprobe 可执行文件路径（缺省时按 PATH / ffmpeg 同目录自动查找）。 */
  readonly ffprobePath?: string | undefined;
  /** 单次交付的帧数上限。 */
  readonly maxFrames?: number | undefined;
  /** 单帧长边上限（像素）。 */
  readonly maxDimension?: number | undefined;
  /** 单帧字节上限。 */
  readonly maxFrameBytes?: number | undefined;
  /** 单次交付的总字节上限。 */
  readonly maxTotalBytes?: number | undefined;
  /** 源文件体积上限（GIF 需整份读入内存）。 */
  readonly maxInputBytes?: number | undefined;
  /** 单次提取超时（毫秒）。 */
  readonly timeoutMs?: number | undefined;
  /** 场景采样阈值（0–1，变化像素占比）。 */
  readonly sceneThreshold?: number | undefined;
  /** 视频帧输出格式。 */
  readonly videoFormat?: VideoFrameFormat | undefined;
  /** JPEG 质量（2–31，越小越清晰）。 */
  readonly jpegQuality?: number | undefined;
  /** 追加的二进制搜索目录（优先于 PATH）。 */
  readonly extraSearchPaths?: readonly string[] | undefined;
}

/** 解析后的媒体选项（全部字段有值，可直接消费）。 */
export interface ResolvedMediaOptions {
  /** ffmpeg 路径（显式配置；`undefined` 时由定位器自动查找）。 */
  readonly ffmpegPath: string | undefined;
  /** ffprobe 路径（显式配置）。 */
  readonly ffprobePath: string | undefined;
  /** 单次交付的帧数上限（已收敛到允许区间）。 */
  readonly maxFrames: number;
  /** 单帧长边上限（像素）。 */
  readonly maxDimension: number;
  /** 单帧字节上限。 */
  readonly maxFrameBytes: number;
  /** 单次交付的总字节上限。 */
  readonly maxTotalBytes: number;
  /** 源文件体积上限。 */
  readonly maxInputBytes: number;
  /** 单次提取超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 场景采样阈值（0–1）。 */
  readonly sceneThreshold: number;
  /** 视频帧输出格式。 */
  readonly videoFormat: VideoFrameFormat;
  /** JPEG 质量。 */
  readonly jpegQuality: number;
  /** 追加的二进制搜索目录。 */
  readonly extraSearchPaths: readonly string[];
  /** 环境变量表（供二进制定位器读取 `OMNI_FFMPEG_PATH` 等）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** 默认值（也是文档口径：配置项缺省即为这些值）。 */
const DEFAULTS = {
  maxFrames: 8,
  maxDimension: 1024,
  maxFrameBytes: 1_500_000,
  maxTotalBytes: 6_000_000,
  maxInputBytes: 134_217_728,
  timeoutMs: 120_000,
  sceneThreshold: 0.3,
  jpegQuality: 4,
} as const;

/** 允许区间（超出即收敛，防止「一个配置把上下文撑爆」）。 */
const LIMITS = {
  maxFrames: { min: 1, max: 32 },
  maxDimension: { min: 128, max: 4096 },
  maxFrameBytes: { min: 65_536, max: 8_388_608 },
  maxTotalBytes: { min: 262_144, max: 33_554_432 },
  maxInputBytes: { min: 1_048_576, max: 2_147_483_648 },
  timeoutMs: { min: 1_000, max: 600_000 },
  sceneThreshold: { min: 0.01, max: 1 },
  jpegQuality: { min: 2, max: 31 },
} as const;

/** 环境变量名。 */
const ENV = {
  maxFrames: 'OMNI_MEDIA_MAX_FRAMES',
  maxDimension: 'OMNI_MEDIA_MAX_DIMENSION',
  timeoutMs: 'OMNI_MEDIA_TIMEOUT_MS',
} as const;

/**
 * 媒体分析配置解析器：把「配置 + 环境变量」收敛成一份**全字段有值**的选项。
 *
 * ## 为什么要有这一层（而不是在工具里散着 `?? 默认值`）
 *
 * ① 默认值必须**单一来源**：散在工具、适配器、文档三处迟早互相矛盾；
 * ② 数值必须**收敛到安全区间**：`maxFrames: 1000` 或 `maxTotalBytes: 1e12` 这类配置
 *    不会报错，只会把模型上下文撑爆（表现为端点 400 或成本暴涨），故在此显式收敛；
 * ③ 环境变量与配置文件并存时的优先级要**写在一个地方**（配置 > 环境变量 > 默认）。
 *
 * ## 优先级
 *
 * 显式配置 > 环境变量（仅三项数值有对应变量）> 内置默认。
 * 收敛是**静默的**，但工具的输出文本会打印生效值——「静默收敛 + 回显生效值」
 * 比「报错拒绝启动」更适合这类展示型参数（用户只是想多给几帧）。
 */
export class MediaConfigResolver {
  /**
   * 解析媒体选项。
   *
   * @param config 配置段（可为 `undefined`）。
   * @param env 环境变量表（缺省用 `process.env`）。
   * @returns 全字段有值的媒体选项。
   */
  public static resolve(
    config: MediaAnalysisConfig | undefined,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): ResolvedMediaOptions {
    const maxFrames = MediaConfigResolver.integer(
      config?.maxFrames,
      env[ENV.maxFrames],
      DEFAULTS.maxFrames,
      LIMITS.maxFrames,
    );
    return {
      ffmpegPath: MediaConfigResolver.text(config?.ffmpegPath),
      ffprobePath: MediaConfigResolver.text(config?.ffprobePath),
      maxFrames,
      maxDimension: MediaConfigResolver.integer(
        config?.maxDimension,
        env[ENV.maxDimension],
        DEFAULTS.maxDimension,
        LIMITS.maxDimension,
      ),
      maxFrameBytes: MediaConfigResolver.integer(
        config?.maxFrameBytes,
        undefined,
        DEFAULTS.maxFrameBytes,
        LIMITS.maxFrameBytes,
      ),
      maxTotalBytes: MediaConfigResolver.integer(
        config?.maxTotalBytes,
        undefined,
        DEFAULTS.maxTotalBytes,
        LIMITS.maxTotalBytes,
      ),
      maxInputBytes: MediaConfigResolver.integer(
        config?.maxInputBytes,
        undefined,
        DEFAULTS.maxInputBytes,
        LIMITS.maxInputBytes,
      ),
      timeoutMs: MediaConfigResolver.integer(
        config?.timeoutMs,
        env[ENV.timeoutMs],
        DEFAULTS.timeoutMs,
        LIMITS.timeoutMs,
      ),
      sceneThreshold: MediaConfigResolver.decimal(
        config?.sceneThreshold,
        DEFAULTS.sceneThreshold,
        LIMITS.sceneThreshold,
      ),
      videoFormat: config?.videoFormat === 'png' ? 'png' : 'jpeg',
      jpegQuality: MediaConfigResolver.integer(
        config?.jpegQuality,
        undefined,
        DEFAULTS.jpegQuality,
        LIMITS.jpegQuality,
      ),
      extraSearchPaths: (config?.extraSearchPaths ?? []).filter((entry) => entry !== ''),
      env,
    };
  }

  /**
   * 取整数值（配置 > 环境变量 > 默认），并收敛到区间。
   *
   * @param configured 配置值。
   * @param fromEnv 环境变量原始文本。
   * @param fallback 默认值。
   * @param range 允许区间。
   * @returns 收敛后的整数。
   */
  private static integer(
    configured: number | undefined,
    fromEnv: string | undefined,
    fallback: number,
    range: { readonly min: number; readonly max: number },
  ): number {
    const candidate =
      typeof configured === 'number' && Number.isFinite(configured)
        ? configured
        : MediaConfigResolver.parseNumber(fromEnv);
    const value = candidate ?? fallback;
    return Math.min(range.max, Math.max(range.min, Math.round(value)));
  }

  /**
   * 取小数值（仅配置），并收敛到区间。
   *
   * @param configured 配置值。
   * @param fallback 默认值。
   * @param range 允许区间。
   * @returns 收敛后的数值。
   */
  private static decimal(
    configured: number | undefined,
    fallback: number,
    range: { readonly min: number; readonly max: number },
  ): number {
    const value =
      typeof configured === 'number' && Number.isFinite(configured) ? configured : fallback;
    return Math.min(range.max, Math.max(range.min, value));
  }

  /**
   * 解析环境变量里的数字（非法值返回 `undefined`，由调用方回落默认）。
   *
   * @param raw 原始文本。
   * @returns 数字；不可解析时为 `undefined`。
   */
  private static parseNumber(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  /**
   * 规整字符串配置（空串视为未配置）。
   *
   * @param raw 原始值。
   * @returns 非空字符串或 `undefined`。
   */
  private static text(raw: string | undefined): string | undefined {
    return raw === undefined || raw.trim() === '' ? undefined : raw;
  }
}
