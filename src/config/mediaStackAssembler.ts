import { FfmpegFrameExtractor } from '../adapters/media/ffmpegFrameExtractor.js';
import { FfmpegLocator } from '../adapters/media/ffmpegLocator.js';
import { FfmpegStderrMediaProbe } from '../adapters/media/ffmpegStderrMediaProbe.js';
import { FfprobeMediaProbe } from '../adapters/media/ffprobeMediaProbe.js';
import { GifFrameExtractor } from '../adapters/media/gifFrameExtractor.js';
import { MediaProbeChain } from '../adapters/media/mediaProbeChain.js';
import { PathBinaryResolver } from '../adapters/media/pathBinaryResolver.js';
import { RoutingFrameExtractor } from '../adapters/media/routingFrameExtractor.js';
import { BoundedMediaProcessRunner } from '../adapters/media/boundedMediaProcessRunner.js';
import { SpawnMediaProcessRunner } from '../adapters/media/spawnMediaProcessRunner.js';
import { FrameEncoder } from '../media/frameEncoder.js';
import { MediaConfigResolver } from './mediaConfigResolver.js';
import type { MediaAnalysisConfig, ResolvedMediaOptions } from './mediaConfigResolver.js';
import type { MediaFrameExtractor } from '../ports/media/frameExtractor.js';
import { LimitEnv } from '../util/limitEnv.js';

/** 二进制定位验证超时（毫秒）：`-version` 是毫秒级动作，10s 已是极宽松上界。 */
const VERIFY_TIMEOUT_MS = 10_000;

/** 单支媒体栈的 ffmpeg 家族进程并发上限（安全闸，非调参旋钮；可由 `OMNI_MEDIA_PROCESS_CONCURRENCY` 覆盖）。 */
const MAX_CONCURRENT_PROCESSES = LimitEnv.int('OMNI_MEDIA_PROCESS_CONCURRENCY', 4);

/**
 * 媒体抽帧栈：一支「路由提取器」+ 一份已收敛的选项。
 *
 * 为什么把两者绑在一起（而不是各传各的）：`ViewMediaTool` 需要**同一个**预算口径去
 * ① 组装 `FrameSelectionPolicy`（给提取器看）与 ② 在输出文本里回显生效值（给模型看）。
 * 若两者来自不同来源，就必然出现「工具说上限 8 帧、提取器实际按 20 帧做」这类漂移。
 */
export interface MediaStack {
  /** 帧提取路由（按媒体大类分发到 GIF 解码或 ffmpeg 抽帧）。 */
  readonly extractor: MediaFrameExtractor;
  /** 已收敛的媒体选项（全字段有值）。 */
  readonly options: ResolvedMediaOptions;
}

/**
 * 媒体抽帧栈装配器（组合根）。
 *
 * ## 为什么单独一层（而不是在工具构造处顺手套上）
 *
 * 媒体能力**按容器分流**，两条路的依赖完全不同：
 * - 动画 GIF ⇒ 纯 TypeScript 解码（零外部二进制，任何机器可用）；
 * - 视频 ⇒ 本机 ffmpeg（`ffmpeg` 抽帧 + `ffprobe`/stderr 探测元数据）。
 *
 * 差别只应体现在「谁被注册进路由」，而不该让工具、配置、错误文案各判一次。
 * 本类把「选项收敛 → 二进制定位 → 探测链 → 编码器 → 提取器路由」一次装好，
 * 让工具层与子智能体装配层共享**同一份已装配产物**（而不是各自 `new` 一遍，
 * 那会得到两个独立的定位缓存与两套预算口径）。
 *
 * ## 为什么不做「无 ffmpeg 就不装配」的开关
 *
 * 视频路径缺 ffmpeg 时，工具的失败信息是**可行动的**（说明怎么装、怎么配 `media.ffmpegPath`），
 * 而 GIF 路径与 ffmpeg 无关 —— 一律装配才能让「同一台机器上 GIF 可用、视频不可用」
 * 这件事由**运行时事实**说话，而不是由装配期猜测。
 *
 * ## 惰性
 *
 * 构造本栈**不做任何进程 I/O**：`FfmpegLocator` 的定位结果是惰性 promise，
 * 首次抽帧才跑一次 `-version`（并缓存）。故「装配了但从不看视频」零成本。
 */
export class MediaStackAssembler {
  /**
   * 装配媒体抽帧栈。
   *
   * @param config 媒体配置段（`OmniHarnessConfig.media`，可为 `undefined` = 全默认）。
   * @param env 环境变量表（缺省 `process.env`；`OMNI_FFMPEG_PATH` 等由定位器读取）。
   * @returns 已装配的媒体栈（提取路由 + 收敛后的选项）。
   */
  public static assemble(
    config: MediaAnalysisConfig | undefined,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): MediaStack {
    const options = MediaConfigResolver.resolve(config, env);
    // 并发闸：裸 spawn 对并发无上限，多 agent 并发抽视频会同时拉起任意多个 ffmpeg；
    // 包一层有界执行器，超过上限的请求排队，前面的进程退场后 FIFO 补位。
    const runner = new BoundedMediaProcessRunner(
      new SpawnMediaProcessRunner(),
      MAX_CONCURRENT_PROCESSES,
    );
    const locator = new FfmpegLocator({
      configuredFfmpegPath: options.ffmpegPath,
      configuredFfprobePath: options.ffprobePath,
      env: options.env,
      resolver: PathBinaryResolver.forEnvironment(options.env, options.extraSearchPaths),
      runner,
      verifyTimeoutMs: VERIFY_TIMEOUT_MS,
    });
    // 探测链顺序即优先级：ffprobe JSON 字段最全；它不可用时退化到解析 `ffmpeg -i` 的 stderr。
    const probe = new MediaProbeChain([
      new FfprobeMediaProbe(locator, runner),
      new FfmpegStderrMediaProbe(locator, runner),
    ]);
    const encoder = new FrameEncoder(options.maxDimension, options.maxFrameBytes);
    // 注册顺序即优先级（路由取第一个 `supports` 命中的实现）；当前两类互斥，顺序仅作声明。
    const extractor = new RoutingFrameExtractor([
      new GifFrameExtractor(options.maxInputBytes, encoder),
      new FfmpegFrameExtractor({
        locator,
        runner,
        probe,
        videoFormat: options.videoFormat,
        jpegQuality: options.jpegQuality,
      }),
    ]);
    return { extractor, options };
  }
}
