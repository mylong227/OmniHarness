import type { RasterImage } from './rasterTypes.js';

/**
 * RGBA 光栅缩放器（盒式滤波 / 面积平均，纯 TS）。
 *
 * ## 为什么需要缩放
 *
 * 交付给模型的帧会被 base64 编码后再进上下文：**分辨率直接换算成 token 与带宽**。
 * 1080p 的一帧未压缩 RGBA 是 8.3 MB，即使 PNG 压缩后也远超单帧预算；而模型判读
 * 「画面里发生了什么 / 两张图差别在哪」并不需要原始分辨率。因此每帧先缩到长边阈值内。
 *
 * ## 算法取舍
 *
 * 用**盒式（面积平均）**而不是最近邻：
 * - 最近邻在缩小动画帧时会丢整行整列像素，可能让「一小块高亮区域」在模型侧直接消失
 *   （判读 UI 变色、指示灯这类场景会得到错误结论）；
 * - 面积平均会把每个目标像素覆盖的源区域平均起来，代价仍然是 O(源像素)，实现只需两个循环；
 * - 放大（目标 > 源）**不做**：放大不增加信息，还会浪费字节，直接返回源。
 *
 * 通道按**非预乘**语义平均（本管线全程非预乘，GIF/PNG 都是非预乘），alpha 一并平均，
 * 避免透明边缘出现黑边。
 */
export class RasterScaler {
  /**
   * 把图像缩到「长边不超过 maxDimension」；不需要缩小时原样返回。
   *
   * @param raster 源图像。
   * @param maxDimension 长边上限（像素，须 ≥1）。
   * @returns 缩放后的图像（可能是同一个对象，调用方不应假设拷贝）。
   */
  public static fit(raster: RasterImage, maxDimension: number): RasterImage {
    const longest = Math.max(raster.width, raster.height);
    if (longest <= maxDimension || maxDimension < 1) {
      return raster;
    }
    const ratio = maxDimension / longest;
    const width = Math.max(1, Math.round(raster.width * ratio));
    const height = Math.max(1, Math.round(raster.height * ratio));
    return RasterScaler.resize(raster, width, height);
  }

  /**
   * 缩放到指定尺寸（面积平均；目标尺寸大于源时退化为最近邻拷贝）。
   *
   * @param raster 源图像。
   * @param width 目标宽度（≥1）。
   * @param height 目标高度（≥1）。
   * @returns 缩放后的图像。
   */
  public static resize(raster: RasterImage, width: number, height: number): RasterImage {
    if (width === raster.width && height === raster.height) {
      return raster;
    }
    const target = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceTop = Math.floor((y * raster.height) / height);
      const sourceBottom = Math.max(sourceTop + 1, Math.floor(((y + 1) * raster.height) / height));
      for (let x = 0; x < width; x += 1) {
        const sourceLeft = Math.floor((x * raster.width) / width);
        const sourceRight = Math.max(sourceLeft + 1, Math.floor(((x + 1) * raster.width) / width));
        RasterScaler.average(
          raster,
          sourceLeft,
          sourceTop,
          sourceRight,
          sourceBottom,
          target,
          (y * width + x) * 4,
        );
      }
    }
    return { rgba: target, width, height };
  }

  /**
   * 把一个源矩形区域平均成一个目标像素（面积平均）。
   *
   * @param raster 源图像。
   * @param left 源矩形左边界（含）。
   * @param top 源矩形上边界（含）。
   * @param right 源矩形右边界（不含）。
   * @param bottom 源矩形下边界（不含）。
   * @param target 目标缓冲。
   * @param offset 目标像素的字节偏移。
   * @returns 无返回值。
   */
  private static average(
    raster: RasterImage,
    left: number,
    top: number,
    right: number,
    bottom: number,
    target: Uint8Array,
    offset: number,
  ): void {
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let count = 0;
    for (let y = top; y < bottom && y < raster.height; y += 1) {
      for (let x = left; x < right && x < raster.width; x += 1) {
        const source = (y * raster.width + x) * 4;
        red += raster.rgba[source] ?? 0;
        green += raster.rgba[source + 1] ?? 0;
        blue += raster.rgba[source + 2] ?? 0;
        alpha += raster.rgba[source + 3] ?? 0;
        count += 1;
      }
    }
    const divisor = count === 0 ? 1 : count;
    target[offset] = Math.round(red / divisor);
    target[offset + 1] = Math.round(green / divisor);
    target[offset + 2] = Math.round(blue / divisor);
    target[offset + 3] = Math.round(alpha / divisor);
  }
}
