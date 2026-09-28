import { deflateSync } from 'node:zlib';
import { Crc32 } from './crc32.js';
import { PngFilterSelector } from './pngFilterSelector.js';
import type { RasterImage } from './rasterTypes.js';

/** PNG 文件签名（8 字节）。 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 位深：8 位/通道（RGBA 8 位是模型端点兼容性最好的组合）。 */
const BIT_DEPTH = 8;
/** 颜色类型：6＝真彩色带 alpha。 */
const COLOR_TYPE_RGBA = 6;
/** deflate 压缩级别：6 是压缩率与耗时的平衡点（逐帧编码发生在工具调用路径上，不能拖慢交互）。 */
const COMPRESSION_LEVEL = 6;

/**
 * PNG 编码器：把 RGBA 像素缓冲编码成 PNG 字节（模型可直接作为图像输入的格式）。
 *
 * ## 为什么自己编码（而不是引图像库）
 *
 * ① **依赖准入**：为「把一帧交出去」引入整条图像库依赖链，收益与成本不成比例；
 * ② PNG 的**非压缩部分**（签名 / IHDR / IEND / CRC）是规范固定的几十字节，
 *    压缩部分由 Node 内置 `zlib` 完成——整件事在百行内、且完全确定；
 * ③ 只支持「RGBA / 8 位 / 无隔行」这一种**最小充分**形态：本编码器的输入恰好是
 *    解码器与缩放器产出的 RGBA，多支持其他形态只会带来无人调用的分支。
 *
 * ## 确定性
 *
 * 同一像素输入在同一 Node 版本下产出**逐字节一致**的输出（固定压缩级别、无时间戳块、
 * 不写 `tEXt`/`tIME`），因此测试可以直接对字节结构做断言，缓存与内容寻址也才成立。
 */
export class PngEncoder {
  /**
   * 编码为 PNG 字节。
   *
   * @param raster RGBA 像素缓冲与尺寸。
   * @returns 完整 PNG 文件字节。
   * @throws {RangeError} 尺寸与缓冲长度不一致时（调用方 bug，早失败优于出坏图）。
   */
  public static encode(raster: RasterImage): Buffer {
    const expected = raster.width * raster.height * 4;
    if (raster.rgba.length !== expected) {
      throw new RangeError(
        `PNG 编码入参不一致：${String(raster.width)}×${String(raster.height)} 需要 ${String(expected)} 字节，` +
          `实际 ${String(raster.rgba.length)} 字节`,
      );
    }
    const filtered = PngFilterSelector.apply(raster.rgba, raster.width, raster.height);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(raster.width, 0);
    header.writeUInt32BE(raster.height, 4);
    header.writeUInt8(BIT_DEPTH, 8);
    header.writeUInt8(COLOR_TYPE_RGBA, 9);
    header.writeUInt8(0, 10); // 压缩方法：0（deflate，规范唯一取值）
    header.writeUInt8(0, 11); // 过滤方法：0（自适应，逐行自选）
    header.writeUInt8(0, 12); // 隔行方法：0（不隔行）
    return Buffer.concat([
      SIGNATURE,
      PngEncoder.chunk('IHDR', header),
      PngEncoder.chunk('IDAT', deflateSync(filtered, { level: COMPRESSION_LEVEL })),
      PngEncoder.chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  /**
   * 组装一个 PNG 块（长度 + 类型 + 数据 + CRC）。
   *
   * @param type 4 字节 ASCII 块类型（如 `IHDR`）。
   * @param data 块数据。
   * @returns 完整块字节。
   */
  private static chunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBytes.copy(chunk, 4);
    data.copy(chunk, 8);
    // CRC 覆盖「类型 + 数据」（不含长度字段）——规范如此，写错只会被解码器判坏块。
    chunk.writeUInt32BE(Crc32.of(chunk, 4, 8 + data.length), 8 + data.length);
    return chunk;
  }
}
