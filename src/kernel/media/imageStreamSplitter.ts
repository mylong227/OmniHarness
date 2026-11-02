/** 一段图像流的编码格式。 */
export type ImageStreamFormat = 'png' | 'jpeg';

/** PNG 文件签名（8 字节）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 单次切分的帧数上限（防御病态输入把内存吃满）。 */
const MAX_FRAMES = 4096;

/** JPEG 段标记常量。 */
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
/** 重启标记区间（FFD0–FFD7，出现在熵编码数据内部，**不是**段边界）。 */
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;

/**
 * 图像流切分器：把 `image2pipe` 式的**首尾相接的多张图片**切成独立的帧字节。
 *
 * ## 为什么需要
 *
 * 视频抽帧的标准通道是「ffmpeg 往 stdout 吐一串 PNG/JPEG」——一次进程调用拿到全部帧，
 * 比拼 N 次进程（每次 seek + 解码）快一个量级，也不需要任何临时文件。
 * 代价是：**必须自己把串切开**。切错一字节，模型看到的就是一张花屏图。
 *
 * ## 两条路径的切分依据（都按格式规范走，不猜）
 *
 * - **PNG**：块结构自带长度字段（`length(4) + type(4) + data + crc(4)`），
 *   顺序走块直到 `IEND` 即为一张完整图 —— 精确、无需扫描。带 CRC 校验的完整性由后续
 *   编码器/模型端点复核，这里只负责**边界**。
 * - **JPEG**：按段结构走（带长度段的标记直接跳过；`SOS` 之后的熵编码数据要逐字节跳过
 *   `FF00` 填充与 `FFD0–FFD7` 重启标记，遇到其他标记才算段边界），到 `EOI` 结束。
 *   **不能**直接「找 FFD9」——APP 段（缩略图/EXIF）内部完全可能含 `FF D9` 字节对，
 *   那样会把一帧切碎。
 *
 * 两处都容忍「头部有垃圾字节」（在下一个签名处重新对齐），但遇到无法解析的尾部即停止，
 * 由调用方按「拿到几帧算几帧」处理（不抛错）。
 */
export class ImageStreamSplitter {
  /**
   * 切分图像流。
   *
   * @param bytes 首尾相接的图像字节。
   * @param format 图像格式（决定走哪条扫描路径）。
   * @returns 每张图的独立字节（按流内顺序；无法解析的尾部被丢弃）。
   */
  public static split(bytes: Buffer, format: ImageStreamFormat): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < bytes.length && frames.length < MAX_FRAMES) {
      const next = ImageStreamSplitter.scanFrom(bytes, offset, format);
      if (next === undefined) {
        break;
      }
      frames.push(bytes.subarray(offset, next.end));
      // 保证游标严格前进：签名损坏时也绝不会死循环。
      offset = next.end > offset ? next.end : offset + 1;
    }
    return frames;
  }

  /**
   * 从给定偏移起找下一张完整图片。
   *
   * @param bytes 图像流字节。
   * @param offset 起始偏移（允许落在垃圾字节上，会在签名处重新对齐）。
   * @param format 图像格式。
   * @returns 该帧的结束偏移；此后不再有完整帧时为 `undefined`。
   */
  private static scanFrom(
    bytes: Buffer,
    offset: number,
    format: ImageStreamFormat,
  ): { readonly end: number } | undefined {
    if (format === 'png') {
      const start = ImageStreamSplitter.alignPng(bytes, offset);
      return start === undefined ? undefined : ImageStreamSplitter.scanPng(bytes, start);
    }
    const start = ImageStreamSplitter.alignJpeg(bytes, offset);
    return start === undefined ? undefined : ImageStreamSplitter.scanJpeg(bytes, start);
  }

  /**
   * 把偏移对齐到下一个 PNG 签名。
   *
   * @param bytes 图像流字节。
   * @param offset 起始偏移。
   * @returns 签名偏移；找不到时为 `undefined`。
   */
  private static alignPng(bytes: Buffer, offset: number): number | undefined {
    for (let index = offset; index + PNG_SIGNATURE.length <= bytes.length; index += 1) {
      if (bytes.subarray(index, index + PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return index;
      }
    }
    return undefined;
  }

  /**
   * 扫描一张 PNG（按块长度推进到 `IEND`）。
   *
   * @param bytes 图像流字节。
   * @param start 签名偏移。
   * @returns 结束偏移；块结构不完整时为 `undefined`。
   */
  private static scanPng(bytes: Buffer, start: number): { readonly end: number } | undefined {
    let cursor = start + PNG_SIGNATURE.length;
    while (cursor + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(cursor);
      const type = bytes.toString('ascii', cursor + 4, cursor + 8);
      const end = cursor + 12 + length;
      if (end > bytes.length) {
        return undefined;
      }
      cursor = end;
      if (type === 'IEND') {
        return { end: cursor };
      }
    }
    return undefined;
  }

  /**
   * 把偏移对齐到下一个 JPEG 起始标记。
   *
   * @param bytes 图像流字节。
   * @param offset 起始偏移。
   * @returns 起始标记偏移；找不到时为 `undefined`。
   */
  private static alignJpeg(bytes: Buffer, offset: number): number | undefined {
    for (let index = offset; index + 1 < bytes.length; index += 1) {
      if (bytes[index] === 0xff && bytes[index + 1] === JPEG_SOI) {
        return index;
      }
    }
    return undefined;
  }

  /**
   * 扫描一张 JPEG（段结构 + 熵数据跳转）。
   *
   * @param bytes 图像流字节。
   * @param start 起始标记偏移。
   * @returns 结束偏移；结构不完整时为 `undefined`。
   */
  private static scanJpeg(bytes: Buffer, start: number): { readonly end: number } | undefined {
    let cursor = start + 2;
    while (cursor + 1 < bytes.length) {
      if (bytes[cursor] !== 0xff) {
        cursor += 1;
        continue;
      }
      const marker = bytes[cursor + 1] ?? 0;
      if (marker === 0xff) {
        cursor += 1; // 填充字节
        continue;
      }
      if (marker === JPEG_EOI) {
        return { end: cursor + 2 };
      }
      if (marker >= JPEG_RST_FIRST && marker <= JPEG_RST_LAST) {
        cursor += 2;
        continue;
      }
      if (cursor + 4 > bytes.length) {
        return undefined;
      }
      const segmentLength = bytes.readUInt16BE(cursor + 2);
      if (segmentLength < 2) {
        return undefined;
      }
      cursor += 2 + segmentLength;
      if (marker === JPEG_SOS) {
        cursor = ImageStreamSplitter.skipEntropyData(bytes, cursor);
      }
    }
    return undefined;
  }

  /**
   * 跳过熵编码数据段（到下一个真正的标记为止）。
   *
   * @param bytes 图像流字节。
   * @param offset 熵数据起点。
   * @returns 下一个标记的偏移（到达流尾时为 `bytes.length`）。
   */
  private static skipEntropyData(bytes: Buffer, offset: number): number {
    let cursor = offset;
    while (cursor + 1 < bytes.length) {
      if (bytes[cursor] !== 0xff) {
        cursor += 1;
        continue;
      }
      const next = bytes[cursor + 1] ?? 0;
      if (next === 0xff) {
        cursor += 1;
        continue;
      }
      // FF00＝字节填充；FFD0–FFD7＝重启标记：两者都属于熵数据本身。
      if (next === 0x00 || (next >= JPEG_RST_FIRST && next <= JPEG_RST_LAST)) {
        cursor += 2;
        continue;
      }
      return cursor;
    }
    return bytes.length;
  }
}
