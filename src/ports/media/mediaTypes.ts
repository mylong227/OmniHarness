/**
 * 媒体（动画 GIF / 视频）契约词汇表 —— 端口层单一来源。
 *
 * ## 为什么需要这一层
 *
 * 在此之前，OmniHarness 对「动的东西」只有一条能力：把整份字节当**一张静态图**塞给模型
 * （`view_image` + `ImageProbe`）。对动画 GIF 与视频，这等于**只看第一帧**：
 * 压缩后的单张字节既丢掉了时间维（动作、转场、状态迁移），又常常体积巨大而被上限直接拒绝。
 * 用户要的「一帧一帧拆开理解」在数据通道上根本不存在。
 *
 * ## 为什么在 `ports/`
 *
 * 消费方横跨 `adapters/tool/media`（工具）、`adapters/media`（提取器）、`config`（装配）。
 * 端口层是唯一共同下游，且本文件只有**类型**（无 class、无第三方、无逻辑），符合端口纯度门禁。
 *
 * ## 术语
 *
 * - **探测（probe）**：只读元数据（时长 / 尺寸 / 帧率 / 帧数 / 编码），不解码像素。
 * - **提取（extract）**：把源按采样策略解成**若干张 PNG 帧**，供模型逐帧判读。
 * - **帧（frame）**：一张已编码的图片 + 它在源中的时间点，二者必须同时交付——
 *   只给图不给时间是「看图猜顺序」，模型无法描述「先发生什么、后发生什么」。
 */

/** 媒体大类（决定走哪条提取通道）。 */
export type MediaKind =
  /** 动画 GIF（纯 TS 解码，零外部二进制）。 */
  | 'gif'
  /** 视频容器（需要本机 ffmpeg） */
  | 'video'
  /** 静态图片（由 `view_image` 负责，本层只用于给出可行动的转介提示）。 */
  | 'image'
  /** 无法识别。 */
  | 'unknown';

/** 采样策略。 */
export type FrameStrategy =
  /** 均匀采样：按时间等距取帧，覆盖全局（默认，最稳）。 */
  | 'uniform'
  /** 场景采样：只在画面发生显著变化处取帧（转场 / 动作切换），单位时间信息密度更高。 */
  | 'scene';

/** 媒体元数据（`probe` 的产物）。 */
export interface MediaProbeInfo {
  /** 媒体大类。 */
  readonly kind: MediaKind;
  /** 容器 / 格式标识（如 `gif` / `mp4` / `webm`）。 */
  readonly container: string;
  /** 视频编码（如 `h264`）；未知为 `undefined`。 */
  readonly codec: string | undefined;
  /** 宽度（像素）；未知为 `undefined`。 */
  readonly width: number | undefined;
  /** 高度（像素）；未知为 `undefined`。 */
  readonly height: number | undefined;
  /** 总时长（毫秒）；静态图或未知为 `undefined`。 */
  readonly durationMs: number | undefined;
  /** 总帧数；未知为 `undefined`。 */
  readonly frameCount: number | undefined;
  /** 平均帧率（帧/秒）；未知为 `undefined`。 */
  readonly frameRate: number | undefined;
  /** 是否为多帧（动画 GIF / 视频为 true，静态图为 false）。 */
  readonly animated: boolean;
}

/** 一帧已编码的图片（交付给模型的最小单位）。 */
export interface MediaFrame {
  /** 在**本次采样结果**中的序号（从 0 起，按时间升序）。 */
  readonly index: number;
  /** 该帧在源中的时间点（毫秒）。 */
  readonly timestampMs: number;
  /** 编码后宽度（像素）。 */
  readonly width: number;
  /** 编码后高度（像素）。 */
  readonly height: number;
  /** 该帧在源中的持续时长（毫秒）；未知为 `undefined`。 */
  readonly durationMs: number | undefined;
  /** 图片 MIME 类型（本实现恒为 `image/png`）。 */
  readonly mediaType: string;
  /** 图片字节。 */
  readonly bytes: Buffer;
}

/** 帧提取的采样与预算约束（全部有默认值，见 `MediaConfigResolver`）。 */
export interface FrameSelectionPolicy {
  /** 采样策略。 */
  readonly strategy: FrameStrategy;
  /** 最多交付多少帧（同时是解码与内存的硬上界）。 */
  readonly maxFrames: number;
  /** 采样窗口起点（毫秒，含）。 */
  readonly startMs: number;
  /** 采样窗口终点（毫秒，含）；`undefined` = 到源结尾。 */
  readonly endMs: number | undefined;
  /** 场景采样阈值（0–1，含义见 {@link FrameStrategy}）；`uniform` 时忽略。 */
  readonly sceneThreshold: number;
  /** 单帧长边上限（像素）：超出即等比缩小。 */
  readonly maxDimension: number;
  /** 单帧字节上限：超出即继续缩小，仍超则丢弃该帧并如实记录。 */
  readonly maxFrameBytes: number;
  /** 本次交付的总字节上限：超出即按时间均匀裁剪帧集合。 */
  readonly maxTotalBytes: number;
}
