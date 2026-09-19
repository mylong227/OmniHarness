/**
 * 图片头解析（`view_image` 的元数据来源，零依赖）。
 *
 * 为什么需要：把图片交给模型之前，先自己**确认它确实是图片**、并报出尺寸——
 * ① 防止把任意二进制当图片塞进模型（既浪费又可能触发接口错误）；
 * ② 尺寸是模型判断「这张图是不是我要的那张」的重要线索；
 * ③ 全部靠读文件头几个字节完成，不解码像素、不用任何图像库。
 */

/** 识别结果。 */
export interface ImageInfo {
  /** MIME 类型（如 `image/png`）。 */
  readonly mediaType: string;
  /** 宽度（像素）；无法解析时为 `undefined`。 */
  readonly width: number | undefined;
  /** 高度（像素）；无法解析时为 `undefined`。 */
  readonly height: number | undefined;
}

/** PNG 文件头魔数。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG 段起始标记。 */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * 图片头解析器（无状态，纯静态）。
 */
export class ImageProbe {
  /**
   * 解析图片元数据。
   *
   * @param bytes 文件字节（只需前若干 KB，多传无妨）。
   * @param extension 扩展名（仅在魔数无法判定时作为兜底线索，可省略）。
   * @returns 识别信息；不是可识别的图片时返回 `undefined`。
   */
  public static probe(bytes: Buffer, extension?: string): ImageInfo | undefined {
    return (
      ImageProbe.png(bytes) ??
      ImageProbe.gif(bytes) ??
      ImageProbe.jpeg(bytes) ??
      ImageProbe.webp(bytes) ??
      ImageProbe.bmp(bytes) ??
      ImageProbe.byExtension(bytes, extension)
    );
  }

  /**
   * 解析 PNG。
   *
   * @param bytes 文件字节。
   * @returns 识别信息；非 PNG 时为 `undefined`。
   */
  private static png(bytes: Buffer): ImageInfo | undefined {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
      return undefined;
    }
    return {
      mediaType: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  /**
   * 解析 GIF。
   *
   * @param bytes 文件字节。
   * @returns 识别信息；非 GIF 时为 `undefined`。
   */
  private static gif(bytes: Buffer): ImageInfo | undefined {
    if (bytes.length < 10) {
      return undefined;
    }
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature !== 'GIF87a' && signature !== 'GIF89a') {
      return undefined;
    }
    return {
      mediaType: 'image/gif',
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  }

  /**
   * 解析 JPEG（扫描到 SOF 段取尺寸）。
   *
   * @param bytes 文件字节。
   * @returns 识别信息；非 JPEG 时为 `undefined`。
   */
  private static jpeg(bytes: Buffer): ImageInfo | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return undefined;
    }
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === undefined) {
        break;
      }
      if (JPEG_SOF.has(marker)) {
        return {
          mediaType: 'image/jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      const length = bytes.readUInt16BE(offset + 2);
      offset += 2 + (length > 0 ? length : 2);
    }
    return { mediaType: 'image/jpeg', width: undefined, height: undefined };
  }

  /**
   * 解析 WebP（覆盖 VP8X / VP8L / VP8 三种容器）。
   *
   * @param bytes 文件字节。
   * @returns 识别信息；非 WebP 时为 `undefined`。
   */
  private static webp(bytes: Buffer): ImageInfo | undefined {
    if (bytes.length < 30) {
      return undefined;
    }
    if (
      bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
    ) {
      return undefined;
    }
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      return {
        mediaType: 'image/webp',
        width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1,
      };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return {
        mediaType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === 'VP8 ') {
      return {
        mediaType: 'image/webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    return { mediaType: 'image/webp', width: undefined, height: undefined };
  }

  /**
   * 解析 BMP。
   *
   * @param bytes 文件字节。
   * @returns 识别信息；非 BMP 时为 `undefined`。
   */
  private static bmp(bytes: Buffer): ImageInfo | undefined {
    if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
      return undefined;
    }
    return {
      mediaType: 'image/bmp',
      width: bytes.readInt32LE(18),
      height: Math.abs(bytes.readInt32LE(22)),
    };
  }

  /**
   * 扩展名兜底：魔数不认识但扩展名明确是图片时，仍按图片处理（不报尺寸）。
   *
   * @param bytes 文件字节（未使用，仅为保持签名一致）。
   * @param extension 小写扩展名（含点，如 `.svg`）。
   * @returns 识别信息；扩展名不属图片时返回 `undefined`。
   */
  private static byExtension(bytes: Buffer, extension: string | undefined): ImageInfo | undefined {
    void bytes;
    switch (extension) {
      case '.svg':
        return { mediaType: 'image/svg+xml', width: undefined, height: undefined };
      case '.ico':
        return { mediaType: 'image/x-icon', width: undefined, height: undefined };
      default:
        return undefined;
    }
  }
}
