import type { GifColorTableRef, GifDisposalMethod, GifImageSpec } from './gifTypes.js';

/** 隔行的 4 遍行序（起始行 + 步长）——GIF 规范 附录 的固定顺序。 */
const INTERLACE_PASSES: readonly { readonly start: number; readonly step: number }[] = [
  { start: 0, step: 8 },
  { start: 4, step: 8 },
  { start: 2, step: 4 },
  { start: 1, step: 2 },
];

/**
 * GIF 帧合成器：维护一张 RGBA 画布，把逐帧的「局部索引图」按 GIF 语义叠加成**完整画面**。
 *
 * ## 为什么必须有这一层
 *
 * GIF 动画的每一帧往往**只包含变化的矩形**（帧 2 可能只有 40×20 像素），
 * 且带「处置方式」决定这一帧之后画布如何变化。直接把每帧的局部像素当整图交给模型，
 * 得到的是「一堆碎片」而不是「连续画面」——这正是「逐帧理解」最容易做错的地方。
 * 本类把处置方式（保留 / 清空 / 还原上一帧）、透明索引、隔行重排、越界裁剪四处
 * 规范细节收在一个地方，解码器只负责按顺序驱动它。
 *
 * ## 语义取舍（明写，避免"看起来对"）
 *
 * - 画布**初始化为全透明**（与浏览器一致），而不是按背景色索引填充：
 *   背景色在老 GIF 里常与透明混用，按透明处理在模型侧更少歧义。
 * - 帧矩形可以**超出**逻辑屏（真实文件存在），超出部分直接裁剪，不报错、不环绕。
 * - 调色板索引越界按黑色处理（见 {@link GifColorTable}）。
 */
export class GifFrameCompositor {
  /** RGBA 画布。 */
  private readonly canvas: Uint8Array;
  /** 「上一帧绘制前」的还原点（处置方式 3 用）。 */
  private restorePoint: Uint8Array | undefined;

  /**
   * @param width 逻辑屏宽度（像素）。
   * @param height 逻辑屏高度（像素）。
   */
  public constructor(
    public readonly width: number,
    public readonly height: number,
  ) {
    this.canvas = new Uint8Array(width * height * 4);
  }

  /**
   * 应用**上一帧**的处置方式（在绘制当前帧之前调用）。
   *
   * @param method 上一帧的处置方式（0/1 保留，2 清空，3 还原）。
   * @returns 无返回值。
   */
  public applyDisposal(method: GifDisposalMethod): void {
    if (method === 2) {
      this.canvas.fill(0);
      return;
    }
    if (method === 3 && this.restorePoint !== undefined) {
      this.canvas.set(this.restorePoint);
    }
  }

  /**
   * 记录还原点：调用方（解码器）在处置方式为 3 的帧**绘制前**调用一次。
   *
   * @returns 无返回值。
   */
  public captureRestorePoint(): void {
    this.restorePoint = Uint8Array.from(this.canvas);
  }

  /**
   * 把一帧索引图绘制到画布（处理透明索引、隔行、越界裁剪）。
   *
   * @param spec 图像块描述（含位置、尺寸、隔行标志、透明索引）。
   * @param table 生效的颜色表（局部表优先，由调用方决定）。
   * @param indices 已解码的调色板索引（长度 = 帧宽 × 帧高）。
   * @returns 无返回值。
   */
  public draw(spec: GifImageSpec, table: GifColorTableRef, indices: Uint8Array): void {
    const rowOrder = spec.interlaced ? GifFrameCompositor.interlaceOrder(spec.height) : undefined;
    for (let sourceRow = 0; sourceRow < spec.height; sourceRow += 1) {
      const row = rowOrder === undefined ? sourceRow : (rowOrder[sourceRow] ?? sourceRow);
      const y = spec.top + row;
      if (y < 0 || y >= this.height) {
        continue;
      }
      this.drawRow(spec, table, indices, sourceRow, y);
    }
  }

  /**
   * 取当前画布快照（副本，调用方拥有所有权）。
   *
   * @returns RGBA 像素副本。
   */
  public snapshot(): Uint8Array {
    return Uint8Array.from(this.canvas);
  }

  /**
   * 绘制一帧中的一行（越界像素裁剪）。
   *
   * @param spec 图像块描述。
   * @param table 生效颜色表。
   * @param indices 索引缓冲。
   * @param sourceRow 源行号（帧内）。
   * @param y 目标行号（画布内）。
   * @returns 无返回值。
   */
  private drawRow(
    spec: GifImageSpec,
    table: GifColorTableRef,
    indices: Uint8Array,
    sourceRow: number,
    y: number,
  ): void {
    const sourceOffset = sourceRow * spec.width;
    let target = (y * this.width + spec.left) * 4;
    for (let column = 0; column < spec.width; column += 1) {
      const targetColumn = spec.left + column;
      if (targetColumn >= this.width) {
        return;
      }
      if (targetColumn >= 0) {
        const index = indices[sourceOffset + column] ?? 0;
        // 透明索引 = 「不画」，画布保留上一层内容（GIF 的透明是"挖洞"语义）。
        if (index !== spec.transparentIndex) {
          table.writeRgba(this.canvas, target, index);
        }
      }
      target += 4;
    }
  }

  /**
   * 生成隔行帧的「源行 → 实际行」映射。
   *
   * 四遍（0/8、4/8、2/4、1/2）合起来覆盖全部行号（偶数行由第 1、3 遍覆盖，奇数行由第 4 遍覆盖），
   * 故 `cursor` 结束时恒等于 `height`，无需补齐分支。
   *
   * @param height 帧高。
   * @returns 长度为 `height` 的映射表。
   */
  private static interlaceOrder(height: number): Int32Array {
    const order = new Int32Array(height);
    let cursor = 0;
    for (const pass of INTERLACE_PASSES) {
      for (let row = pass.start; row < height; row += pass.step) {
        order[cursor] = row;
        cursor += 1;
      }
    }
    return order;
  }
}
