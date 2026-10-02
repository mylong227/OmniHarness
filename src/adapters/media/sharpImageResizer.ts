/**
 * sharp 图片缩放适配器（真实实现）：用 libvips 把大图收敛进模型上下文预算。
 *
 * 铁律合规：
 *  - 本文件位于 src/adapters/media/**，第三方只在此出现；对外仅暴露 ImageResizerPort。
 *  - 「import type + 动态 import()」：类型经 `import type` 引入（编译期擦除，零运行时加载），
 *    实际模块仅在首次缩放时动态加载。sharp 是 optionalDependencies——默认安装（含 optional）
 *    即有；`npm i --omit=optional` 的精简安装没有，此时 {@link loadFactory} 拿不到模块、
 *    `resize` 恒返回 `undefined`，调用方（view_image）退化为「不缩放、超限拒绝」的历史行为。
 *    绝不静默假装缩过。
 *  - 已登记于 dependency-allowlist.json（Apache-2.0，libvips 以动态链接随包分发，见条目说明）。
 *
 * ## 为什么这是能力缺口而不是重复造轮子
 *
 * 零依赖时代 `view_image` 对 >5 MiB 图片只能**拒绝**（工具注释自述「压缩需要图像库」），
 * 且任何大图都全尺寸进模型上下文。手搓一张等价的解码/缩放/重编码管线
 * （JPEG/WEBP/EXIF 方向/色彩配置……）是把 libvips 的十年边缘案例重写一遍，
 * 边际成本不可接受；sharp 已在依赖树（HF 链路 + overrides 锁版本），故按
 * 「择优依赖」政策以 optional 依赖接入，手搓媒体栈保持回退资产地位不变。
 */
import type Sharp from 'sharp';
import type {
  ImageResizeOutcome,
  ImageResizeRequest,
  ImageResizerPort,
} from '../../ports/media/imageResizer.js';

/** sharp 工厂类型（sharp 默认导出的可调用形态：`sharp(buffer) => Sharp 实例`）。 */
type SharpFactory = typeof Sharp;

/** 缩放重试上限：每次乘 {@link SHRINK_RATIO}，与 FrameEncoder 的逐步缩小同口径。 */
const MAX_SHRINK_ATTEMPTS = 6;

/** 单次缩放比例。 */
const SHRINK_RATIO = 0.75;

/** 缩放的最小长边：再小就已经看不清内容，宁可放弃并让调用方按历史行为处理。 */
const MIN_DIMENSION = 256;

/** JPEG 输出质量：照片类源的体积 / 清晰度折中。 */
const JPEG_QUALITY = 85;

/** sharp 编码格式 → MIME 映射。 */
const FORMAT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** 连续色调（照片类）格式：重编码走 JPEG；其余走 PNG（与 GIF/PNG 路径的判据同源）。 */
const PHOTOGRAPHIC_FORMATS: ReadonlySet<string> = new Set([
  'jpeg',
  'jfif',
  'webp',
  'avif',
  'tiff',
  'heif',
]);

/**
 * sharp 图片缩放适配器：解码 → 按长边上限缩放 → 超字节预算则逐步再缩 → 重编码。
 *
 * 缩放不可行（sharp 缺失 / 解码失败 / 元数据缺失 / 缩无可缩仍超预算）一律返回
 * `undefined`，由调用方退化为「原样交付 / 超限拒绝」的历史行为——缩放失败不该
 * 把能看的图变成报错，更不该静默交付一份没缩过的超限图。
 */
export class SharpImageResizer implements ImageResizerPort {
  /** 实现名。 */
  public readonly name = 'sharp-resizer';

  /** 惰性加载的 sharp 工厂（即 sharp 默认导出的可调用类型）；失败记 `null` 不再重试。 */
  private factory: SharpFactory | undefined | null;

  /**
   * 是否支持缩放（探测式快捷判断，供装配 / 诊断用）。
   *
   * @returns sharp 可加载时为 true。
   */
  public async available(): Promise<boolean> {
    return (await this.loadFactory()) !== undefined;
  }

  /**
   * 尝试把图片收敛到预算内。
   *
   * @param request 缩放请求（原始字节 + 预算）。
   * @returns 缩放结果；无法处理（无 sharp / 解码失败 / 元数据缺失 / 缩无可缩仍超预算）时为 `undefined`。
   */
  public async resize(request: ImageResizeRequest): Promise<ImageResizeOutcome | undefined> {
    const factory = await this.loadFactory();
    if (factory === undefined) {
      return undefined;
    }
    try {
      const metadata = await factory(request.bytes).metadata();
      const width = metadata.width;
      const height = metadata.height;
      const format = metadata.format;
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        return undefined;
      }
      const longEdge = Math.max(width, height);
      const oversized =
        request.bytes.byteLength > request.maxBytes || longEdge > request.maxDimension;
      if (!oversized) {
        return {
          bytes: request.bytes,
          mediaType: request.mediaType,
          width,
          height,
          resized: false,
        };
      }
      if (format === undefined || format === 'svg') {
        // SVG 是矢量（交付体积与画布无关），交给调用方原样处理。
        return undefined;
      }
      return await SharpImageResizer.encodeWithin(
        factory,
        request.bytes,
        request.maxDimension,
        request.maxBytes,
        format,
      );
    } catch {
      // 解码失败（损坏 / sharp 不认识该格式）⇒ 退化为不缩放。
      return undefined;
    }
  }

  /**
   * 编码到预算内：先按长边上限缩，仍超单图字节上限则逐步再缩。
   *
   * 每次尝试都从工厂重建管线——sharp 实例是可变链，同一实例上重复 `resize`
   * 会叠加操作而不是替换（见 sharp 文档「Only one resize call per instance」）。
   *
   * @param factory sharp 工厂。
   * @param bytes 原始字节。
   * @param maxDimension 长边上限（像素）。
   * @param maxBytes 字节上限。
   * @param sourceFormat 源格式（决定输出格式与 MIME）。
   * @returns 编码结果；逐步缩到下限仍超预算时为 `undefined`。
   */
  private static async encodeWithin(
    factory: SharpFactory,
    bytes: Buffer,
    maxDimension: number,
    maxBytes: number,
    sourceFormat: string,
  ): Promise<ImageResizeOutcome | undefined> {
    const photographic = PHOTOGRAPHIC_FORMATS.has(sourceFormat);
    let currentLongEdge = maxDimension;
    for (let attempt = 0; attempt <= MAX_SHRINK_ATTEMPTS; attempt += 1) {
      const pipeline = factory(bytes).rotate().resize({
        width: currentLongEdge,
        height: currentLongEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
      const encoded = photographic ? pipeline.jpeg({ quality: JPEG_QUALITY }) : pipeline.png();
      const output = await encoded.toBuffer({ resolveWithObject: true });
      if (output.data.byteLength <= maxBytes) {
        return {
          bytes: output.data,
          mediaType: FORMAT_MEDIA_TYPES[output.info.format] ?? 'image/png',
          width: output.info.width,
          height: output.info.height,
          resized: true,
        };
      }
      if (
        attempt === MAX_SHRINK_ATTEMPTS ||
        Math.max(output.info.width, output.info.height) <= MIN_DIMENSION
      ) {
        return undefined;
      }
      currentLongEdge = Math.max(MIN_DIMENSION, Math.round(currentLongEdge * SHRINK_RATIO));
    }
    return undefined;
  }

  /**
   * 惰性加载 sharp 模块（首次调用后缓存；未安装则记 `null` 恒快速返回 undefined）。
   *
   * @returns sharp 工厂；不可用时为 `undefined`。
   */
  private async loadFactory(): Promise<SharpFactory | undefined> {
    if (this.factory === null) {
      return undefined;
    }
    if (this.factory !== undefined) {
      return this.factory;
    }
    try {
      const mod = (await import('sharp')) as unknown as {
        default?: SharpFactory;
      } & Partial<SharpFactory>;
      const factory = typeof mod === 'function' ? mod : mod.default;
      if (typeof factory !== 'function') {
        this.factory = null;
        return undefined;
      }
      this.factory = factory;
      return factory;
    } catch {
      this.factory = null;
      return undefined;
    }
  }
}
