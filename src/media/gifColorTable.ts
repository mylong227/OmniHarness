import type { GifColorTableRef } from './gifTypes.js';

/**
 * GIF 颜色表（调色板）：把 0–255 的索引映射成 RGB。
 *
 * 为什么做成对象而不是裸 `Uint8Array`：GIF 的颜色表有**两个来源**（全局表与逐帧局部表），
 * 且越界索引在真实文件里并不罕见（老编码器会写出超出表长的索引）。
 * 把「查表 + 越界安全」收进一个地方，合成器就只需关心像素，不必到处防越界。
 * 越界一律映射为**黑色**（而不是抛错或读越界内存），与主流浏览器对损坏 GIF 的容错一致。
 */
export class GifColorTable implements GifColorTableRef {
  /** 颜色数（表内条目数）。 */
  public readonly size: number;

  /**
   * @param bytes 表字节（每色 3 字节 RGB，紧密排列）。
   * @param size 颜色数（由逻辑屏描述符 / 图像描述符的尺寸位推出）。
   */
  public constructor(
    private readonly bytes: Uint8Array,
    size: number,
  ) {
    // 表字节可能少于声明尺寸（截断文件）：以实际可用条目为准，避免读越界。
    this.size = Math.min(size, Math.floor(bytes.length / 3));
  }

  /**
   * 把某个调色板索引写成目标缓冲里的 RGBA 四字节。
   *
   * @param target 目标像素缓冲。
   * @param offset 写入起点（字节偏移）。
   * @param index 调色板索引（越界时写黑色）。
   * @returns 无返回值。
   */
  public writeRgba(target: Uint8Array, offset: number, index: number): void {
    const safe = index < this.size ? index : -1;
    if (safe < 0) {
      target[offset] = 0;
      target[offset + 1] = 0;
      target[offset + 2] = 0;
      target[offset + 3] = 255;
      return;
    }
    const base = safe * 3;
    target[offset] = this.bytes[base] ?? 0;
    target[offset + 1] = this.bytes[base + 1] ?? 0;
    target[offset + 2] = this.bytes[base + 2] ?? 0;
    target[offset + 3] = 255;
  }
}
