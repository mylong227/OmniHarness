import { ImageProbe } from '../util/imageProbe.js';
import type { MediaKind, MediaProbeInfo } from '../ports/media/mediaTypes.js';

/** 视频容器魔数（`ascii` 为 true 时按 ASCII 比较，否则按十六进制字节比较）。 */
const VIDEO_SIGNATURES: readonly {
  readonly container: string;
  readonly offset: number;
  readonly signature: string;
  readonly ascii: boolean;
}[] = [
  // ISO BMFF（mp4 / mov / m4v）：第 4–8 字节为 'ftyp'，品牌各异的变体都走这里。
  { container: 'mp4', offset: 4, signature: 'ftyp', ascii: true },
  // Matroska / WebM：EBML 头。
  { container: 'webm', offset: 0, signature: '1a45dfa3', ascii: false },
  // AVI：`RIFF....AVI `
  { container: 'avi', offset: 8, signature: 'AVI ', ascii: true },
  // Ogg（Theora 等）
  { container: 'ogg', offset: 0, signature: 'OggS', ascii: true },
  // FLV
  { container: 'flv', offset: 0, signature: 'FLV\u0001', ascii: true },
];

/** MPEG-TS 的同步字节（单字节魔数，需多点复核）。 */
const TS_SYNC_BYTE = 0x47;
/** MPEG-TS 包长。 */
const TS_PACKET_SIZE = 188;

/** 静态图片扩展名（除 GIF 之外都应由 `view_image` 负责）。 */
const IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
];

/**
 * 媒体嗅探器：只看文件头就知道「这是动画 GIF / 视频 / 静态图片 / 未知」。
 *
 * ## 为什么必须先嗅探
 *
 * 抽帧通道是**按容器分流**的（GIF 走纯 TS 解码；视频走 ffmpeg；静态图该去找 `view_image`）。
 * 分流判据若用扩展名，改个名字就能把 mp4 当 GIF 送进解码器（反之亦然），
 * 结果只会得到「解码失败」这种**对模型毫无信息量**的报错。按魔数判定则天然拒绝错配，
 * 并能给出「你给的是静态图片，请用 view_image」这种可行动提示。
 *
 * 尺寸信息复用 {@link ImageProbe}（图片头解析已在仓，不再写第二份）。
 * 视频的时长 / 帧率**必须**由外部工具给出，本类不猜（见 `FfmpegStderrParser` 的说明）。
 */
export class MediaSniffer {
  /**
   * 嗅探媒体类型。
   *
   * @param bytes 文件字节（只需前若干 KB，多传无妨）。
   * @param extension 小写扩展名（含点，如 `.gif`），仅在魔数无法判定时作兜底线索。
   * @returns 媒体元数据；无法识别时 `kind` 为 `unknown`。
   */
  public static sniff(bytes: Buffer, extension: string): MediaProbeInfo {
    const container = MediaSniffer.matchVideoContainer(bytes);
    if (container !== undefined) {
      return MediaSniffer.unknownInfo('video', container, true);
    }
    const image = ImageProbe.probe(bytes, extension);
    if (image !== undefined) {
      const kind: MediaKind = image.mediaType === 'image/gif' ? 'gif' : 'image';
      return {
        kind,
        container: image.mediaType.slice('image/'.length),
        codec: undefined,
        width: image.width,
        height: image.height,
        durationMs: undefined,
        frameCount: undefined,
        frameRate: undefined,
        // GIF 是否动画必须解块结构才知道（见 GifDecoder）；此处先按动画处理，
        // 提取阶段会用精确统计覆盖；单帧 GIF 走同一条路径也能正常出图。
        animated: kind === 'gif',
      };
    }
    if (IMAGE_EXTENSIONS.includes(extension)) {
      return MediaSniffer.unknownInfo('image', extension.slice(1), false);
    }
    return MediaSniffer.unknownInfo(
      'unknown',
      extension === '' ? 'unknown' : extension.slice(1),
      false,
    );
  }

  /**
   * 按魔数匹配视频容器。
   *
   * @param bytes 文件字节。
   * @returns 容器名；未命中时为 `undefined`。
   */
  private static matchVideoContainer(bytes: Buffer): string | undefined {
    for (const candidate of VIDEO_SIGNATURES) {
      if (MediaSniffer.matchesAt(bytes, candidate.offset, candidate.signature, candidate.ascii)) {
        return candidate.container;
      }
    }
    return MediaSniffer.looksLikeTransportStream(bytes) ? 'mpegts' : undefined;
  }

  /**
   * 判定某个偏移处的字节是否等于给定签名。
   *
   * @param bytes 文件字节。
   * @param offset 偏移。
   * @param signature ASCII 串（`ascii` 为 true）或十六进制串。
   * @param ascii 是否按 ASCII 比较。
   * @returns 匹配时为 true。
   */
  private static matchesAt(
    bytes: Buffer,
    offset: number,
    signature: string,
    ascii: boolean,
  ): boolean {
    if (offset + signature.length > bytes.length) {
      return false;
    }
    if (!ascii) {
      return bytes.subarray(offset, offset + signature.length).toString('hex') === signature;
    }
    return bytes.toString('latin1', offset, offset + signature.length) === signature;
  }

  /**
   * 判断是否像 MPEG-TS（单字节魔数必须多点复核，否则任意二进制都可能命中）。
   *
   * @param bytes 文件字节。
   * @returns 像传输流时为 true。
   */
  private static looksLikeTransportStream(bytes: Buffer): boolean {
    return (
      bytes.length > TS_PACKET_SIZE * 2 &&
      bytes[0] === TS_SYNC_BYTE &&
      bytes[TS_PACKET_SIZE] === TS_SYNC_BYTE &&
      bytes[TS_PACKET_SIZE * 2] === TS_SYNC_BYTE
    );
  }

  /**
   * 构造「除大类与容器外全部未知」的元数据。
   *
   * @param kind 媒体大类。
   * @param container 容器名。
   * @param animated 是否按动画处理。
   * @returns 元数据。
   */
  private static unknownInfo(
    kind: MediaKind,
    container: string,
    animated: boolean,
  ): MediaProbeInfo {
    return {
      kind,
      container,
      codec: undefined,
      width: undefined,
      height: undefined,
      durationMs: undefined,
      frameCount: undefined,
      frameRate: undefined,
      animated,
    };
  }
}
