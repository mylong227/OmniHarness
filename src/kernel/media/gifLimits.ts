/**
 * GIF 解码的硬上限（外部不可信输入的内存闸）。
 *
 * 为什么必须有：GIF 的逻辑屏与帧矩形都是文件头里的 **16 位**字段，65535²×4 ≈ 17 GB。
 * 没有上限时，一个几十字节的文件就能让进程 OOM（或被 V8 的 `RangeError` 打断，
 * 而解码器的容错只捕获 `MediaFormatError`）。
 *
 * 取值：4096×4096 = 16,777,216 像素（4K 正方形），画布 RGBA 上限 64 MiB；
 * 帧矩形同口径。真实表情包/截图远小于此，超过即可判定为恶意或损坏。
 */
export class GifLimits {
  /** 逻辑屏最大像素数（宽×高）。 */
  public static readonly MAX_CANVAS_PIXELS = 16_777_216;
  /** 单帧矩形最大像素数（宽×高）。 */
  public static readonly MAX_FRAME_PIXELS = 16_777_216;
}
