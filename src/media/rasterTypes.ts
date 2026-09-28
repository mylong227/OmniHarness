/**
 * 光栅图像（RGBA 像素缓冲 + 尺寸）——图像处理管线的通用中间形态。
 *
 * 为什么单独成类型：GIF 解码、缩放、PNG 编码三段的输入输出都是「一块 RGBA + 宽高」，
 * 用一个类型把它们串起来，任何一段都可以独立测试与替换（换解码器不影响编码器）。
 */
export interface RasterImage {
  /** 像素缓冲（宽 × 高 × 4 字节，RGBA，行优先，非预乘 alpha）。 */
  readonly rgba: Uint8Array;
  /** 宽度（像素，≥1）。 */
  readonly width: number;
  /** 高度（像素，≥1）。 */
  readonly height: number;
}
