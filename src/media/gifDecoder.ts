import { MediaFormatError } from '../errors/mediaFormatError.js';
import { GifBinaryReader } from './gifBinaryReader.js';
import { GifColorTable } from './gifColorTable.js';
import { GifFrameCompositor } from './gifFrameCompositor.js';
import { GifLzwDecoder } from './gifLzwDecoder.js';
import type {
  GifAnimation,
  GifDecodeOptions,
  GifDecodedFrame,
  GifDisposalMethod,
  GifFrameTiming,
  GifImageSpec,
} from './gifTypes.js';

/** 块标记：扩展块。 */
const MARKER_EXTENSION = 0x21;
/** 块标记：图像描述符。 */
const MARKER_IMAGE = 0x2c;
/** 块标记：文件结束。 */
const MARKER_TRAILER = 0x3b;
/** 扩展标签：图形控制扩展。 */
const LABEL_GRAPHIC_CONTROL = 0xf9;
/** 扩展标签：应用扩展（循环次数藏在这里）。 */
const LABEL_APPLICATION = 0xff;
/** 循环扩展的应用标识前缀（NETSCAPE2.0 与 ANIMEXTS1.0 是同一语义的两种写法）。 */
const LOOP_EXTENSION_PREFIXES: readonly string[] = ['NETSCAPE2.0', 'ANIMEXTS1.0'];
/** 浏览器对「过短延迟」的归一化阈值与替代值（毫秒）——与主流实现保持一致。 */
const MIN_MEANINGFUL_DELAY_MS = 20;
const SUBSTITUTE_DELAY_MS = 100;
/** 无图形控制扩展时的默认帧延迟（毫秒）。 */
const DEFAULT_FRAME_DELAY_MS = SUBSTITUTE_DELAY_MS;

/** 图形控制扩展携带的、作用于**下一个**图像块的帧属性。 */
interface PendingControl {
  /** 归一化后的帧延迟（毫秒）。 */
  readonly delayMs: number;
  /** 处置方式。 */
  readonly disposal: GifDisposalMethod;
  /** 透明索引（`undefined`＝该帧无透明）。 */
  readonly transparentIndex: number | undefined;
}

/**
 * GIF 解码器：把一份 GIF 字节流解成「逐帧 RGBA + 时间线 + 结构统计」。
 *
 * ## 三种使用模式（由 {@link GifDecodeOptions} 选择，互不冲突）
 *
 * | 模式 | 触发 | 用途 | 代价 |
 * | ---- | ---- | ---- | ---- |
 * | 结构扫描 | `skipPixels` | 探测（帧数 / 总时长 / 尺寸），不解 LZW | 只读块结构，最快 |
 * | 定向解码 | `wantedIndices` + `stopAfterIndex` | 只要若干帧（均匀采样） | 解到最后一帧被选中处即停 |
 * | 流式观察 | `onFrame` | 场景采样（需要比较相邻帧） | 全量解码，但调用方自有内存上界 |
 *
 * ## 为什么前序帧「不需要也得解」
 *
 * GIF 动画的帧是**增量**的：第 7 帧可能只有一个 40×20 的小矩形，而它显示时的完整画面
 * 取决于第 1–6 帧按各自处置方式叠加的结果。因此画布状态必须顺序推进，
 * `wantedIndices` 省下的是**快照与内存**，不是解码本身——这一点在参数命名与文档里都写明，
 * 免得后来者误以为它是「随机访问」。
 */
export class GifDecoder {
  /** 字节游标。 */
  private readonly reader: GifBinaryReader;
  /** 帧合成器（逻辑屏尺寸在建好后确定）。 */
  private readonly compositor: GifFrameCompositor;
  /** 全局颜色表（可能缺省）。 */
  private readonly globalColorTable: GifColorTable | undefined;
  /** 解析选项。 */
  private readonly options: GifDecodeOptions;
  /** 应用扩展声明的循环次数（0＝无限；缺省 0）。 */
  private loopCount = 0;
  /** 源中已扫描到的帧数。 */
  private frameCount = 0;
  /** 按归一化延迟累计的动画总时长。 */
  private elapsedMs = 0;
  /** 已保留（快照）的帧。 */
  private readonly retained: GifDecodedFrame[] = [];
  /** 帧时间轴（不含像素，始终完整收集）。 */
  private readonly timeline: GifFrameTiming[] = [];
  /** 待生效的帧属性（由图形控制扩展设置）。 */
  private pending: PendingControl = GifDecoder.defaultControl();
  /** 上一个已绘制帧的处置方式。 */
  private previousDisposal: GifDisposalMethod = 0;
  /** 因码流不完整而受损的帧数（如实上报，不静默）。 */
  private damagedFrames = 0;
  /** 是否因帧数上限 / 提前停止而截断扫描。 */
  private truncated = false;

  /**
   * @param bytes 完整 GIF 字节。
   * @param options 解码选项。
   */
  private constructor(bytes: Buffer, options: GifDecodeOptions) {
    this.reader = new GifBinaryReader(bytes);
    this.options = options;
    const signature = this.reader.readString(6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') {
      throw new MediaFormatError(`不是 GIF 文件：文件头为 "${signature}"`);
    }
    const width = this.reader.readUInt16LE();
    const height = this.reader.readUInt16LE();
    const packed = this.reader.readUInt8();
    this.reader.readUInt8(); // 背景色索引：本实现按浏览器语义把画布初始化为全透明，故不使用
    this.reader.readUInt8(); // 像素宽高比：0＝未指定
    this.compositor = new GifFrameCompositor(width, height);
    this.globalColorTable =
      (packed & 0x80) !== 0
        ? new GifColorTable(this.reader.readBytes(3 * (2 << (packed & 0x07))), 2 << (packed & 0x07))
        : undefined;
  }

  /**
   * 解码一份 GIF。
   *
   * @param bytes 完整 GIF 字节。
   * @param options 解码选项（缺省＝全量解码全部帧）。
   * @returns 动画结构 + 被选中的帧。
   * @throws {MediaFormatError} 文件头 / 逻辑屏 / 全局颜色表非法时。
   *   注意：块结构的**中段**损坏或数据截断**不抛错**，而是停止扫描并置 `truncated`（见 `parse`）。
   */
  public static decode(bytes: Buffer, options: GifDecodeOptions = {}): GifAnimation {
    return new GifDecoder(bytes, options).parse();
  }

  /**
   * 主解析循环。
   *
   * ## 容错边界（明写，因为这是「响亮报错」与「尽力可用」之间的取舍）
   *
   * - **文件头 / 逻辑屏 / 全局颜色表**损坏 ⇒ 抛 `MediaFormatError`（构造函数里抛）：
   *   连坐标系与调色板都没有，此时交付任何像素都等于**编造**，必须响亮失败。
   * - **块结构中段损坏或数据被截断** ⇒ 停止扫描并置 `truncated`：网络中断、下载不全的
   *   GIF 遍地都是；此时已解出的帧是**确定的真实像素**，丢掉它们对使用者毫无益处，
   *   而上报 `truncated` 又保证了「不静默」。**「库里有能力」不等于「路径上生效」——
   *   这条容错路径由 `tests/unit/gifDecoder.test.ts` 的截断点扫描兜底。**
   *
   * @returns 动画结构 + 被选中的帧。
   */
  private parse(): GifAnimation {
    this.scanBlocks();
    return {
      width: this.compositor.width,
      height: this.compositor.height,
      loopCount: this.loopCount,
      frameCount: this.frameCount,
      totalDurationMs: this.elapsedMs,
      timeline: this.timeline,
      frames: this.retained,
      damagedFrameCount: this.damagedFrames,
      truncated: this.truncated,
    };
  }

  /**
   * 顺序扫描顶层块；一旦遭遇结构损坏或数据截断即停止，并如实标记 `truncated`。
   *
   * @returns 无返回值。
   */
  private scanBlocks(): void {
    while (this.reader.remaining > 0) {
      try {
        if (!this.readBlock()) {
          return;
        }
      } catch (error) {
        if (!(error instanceof MediaFormatError)) {
          throw error;
        }
        // 中途损坏 / 截断：已解出的帧照常交付，但不得假装扫描完整。
        this.truncated = true;
        return;
      }
    }
    // 字节耗尽却没读到文件结束标记（0x3B）⇒ 文件不完整，同样必须如实上报。
    this.truncated = true;
  }

  /**
   * 读一个顶层块。
   *
   * @returns 应继续扫描时为 true；遇文件结束标记或已满足停止条件时为 false。
   */
  private readBlock(): boolean {
    const marker = this.reader.readUInt8();
    if (marker === MARKER_TRAILER) {
      return false;
    }
    if (marker === MARKER_EXTENSION) {
      this.readExtension();
      return true;
    }
    if (marker === MARKER_IMAGE) {
      return this.readImageBlock();
    }
    throw new MediaFormatError(
      `GIF 块结构损坏：偏移 ${String(this.reader.position - 1)} 处出现未知标记 0x${marker
        .toString(16)
        .padStart(2, '0')}`,
      this.reader.position - 1,
    );
  }

  /**
   * 读取一个扩展块（图形控制 / 应用 / 注释 / 纯文本）。
   *
   * @returns 无返回值。
   */
  private readExtension(): void {
    const label = this.reader.readUInt8();
    if (label === LABEL_GRAPHIC_CONTROL) {
      this.readGraphicControl();
      return;
    }
    const blockSize = this.reader.readUInt8();
    if (label === LABEL_APPLICATION) {
      this.readApplication(this.reader.readString(blockSize));
      return;
    }
    // 注释（0xFE）/ 纯文本（0x01）等：跳过其内容子块即可。
    this.reader.skip(blockSize);
    this.reader.skipSubBlocks();
  }

  /**
   * 读取图形控制扩展（帧延迟 / 处置方式 / 透明索引）。
   *
   * @returns 无返回值。
   */
  private readGraphicControl(): void {
    const size = this.reader.readUInt8();
    if (size < 4) {
      // 真实文件里出现过短块：跳过声明长度后继续，不因个别坏块丢掉整个动画。
      this.reader.skip(size);
      this.reader.skipSubBlocks();
      return;
    }
    const packed = this.reader.readUInt8();
    const delayCs = this.reader.readUInt16LE();
    const transparentIndex = this.reader.readUInt8();
    this.reader.skip(size - 4);
    this.reader.skipSubBlocks();
    const disposal = ((packed >> 2) & 0x07) as GifDisposalMethod;
    this.pending = {
      delayMs: GifDecoder.normalizeDelay(delayCs * 10),
      disposal: disposal <= 3 ? disposal : 0,
      transparentIndex: (packed & 0x01) !== 0 ? transparentIndex : undefined,
    };
  }

  /**
   * 读取应用扩展；若为循环扩展则记录循环次数。
   *
   * @param identifier 应用标识（如 `NETSCAPE2.0`）。
   * @returns 无返回值。
   */
  private readApplication(identifier: string): void {
    const payload = this.reader.readSubBlocks();
    const isLoop =
      LOOP_EXTENSION_PREFIXES.some((prefix) => identifier.startsWith(prefix)) &&
      payload.length >= 3;
    if (isLoop && payload[0] === 0x03) {
      this.loopCount = (payload[1] ?? 0) | ((payload[2] ?? 0) << 8);
    }
  }

  /**
   * 读取一个图像块并推进画布。
   *
   * @returns 应继续扫描时为 true；已满足 `stopAfterIndex` / `maxFrames` 时为 false。
   */
  private readImageBlock(): boolean {
    const left = this.reader.readUInt16LE();
    const top = this.reader.readUInt16LE();
    const width = this.reader.readUInt16LE();
    const height = this.reader.readUInt16LE();
    const packed = this.reader.readUInt8();
    const interlaced = (packed & 0x40) !== 0;
    const tableSize = 2 << (packed & 0x07);
    const localColorTable =
      (packed & 0x80) !== 0
        ? new GifColorTable(this.reader.readBytes(3 * tableSize), tableSize)
        : undefined;
    const minCodeSize = this.reader.readUInt8();
    const data = this.reader.readSubBlocks();
    const sourceIndex = this.frameCount;
    this.frameCount += 1;
    const control = this.pending;
    this.pending = GifDecoder.defaultControl();
    const timestampMs = this.elapsedMs;
    // 时间轴在**任何模式**下都完整收集：它不含像素，是采样的唯一依据。
    this.timeline.push({ sourceIndex, timestampMs, delayMs: control.delayMs });
    if (!this.options.skipPixels) {
      this.composite(
        sourceIndex,
        timestampMs,
        { left, top, width, height, interlaced, localColorTable, minCodeSize, data },
        control,
      );
    }
    this.elapsedMs += control.delayMs;
    this.previousDisposal = control.disposal;
    if (this.shouldStop(sourceIndex)) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  /**
   * 合成一帧（含处置推进、透明、隔行、损坏统计），并按保留策略快照。
   *
   * @param sourceIndex 源帧序号。
   * @param timestampMs 该帧起始时间（毫秒）。
   * @param raw 图像块原始描述（缺 `disposal` / `transparentIndex` / `delayMs`，由 `control` 补齐）。
   * @param control 生效的帧属性。
   * @returns 无返回值。
   */
  private composite(
    sourceIndex: number,
    timestampMs: number,
    raw: Omit<GifImageSpec, 'disposal' | 'transparentIndex' | 'delayMs'>,
    control: PendingControl,
  ): void {
    const spec: GifImageSpec = { ...raw, ...control };
    this.compositor.applyDisposal(this.previousDisposal);
    if (control.disposal === 3) {
      this.compositor.captureRestorePoint();
    }
    const decoded = GifLzwDecoder.decode(raw.data, raw.minCodeSize, raw.width * raw.height);
    if (!decoded.complete) {
      this.damagedFrames += 1;
    }
    const table = raw.localColorTable ?? this.globalColorTable;
    if (table === undefined) {
      throw new MediaFormatError('GIF 帧既无局部颜色表也无全局颜色表，无法还原像素');
    }
    this.compositor.draw(spec, table, decoded.indices);
    const frame: GifDecodedFrame = {
      rgba: this.compositor.snapshot(),
      width: this.compositor.width,
      height: this.compositor.height,
      delayMs: control.delayMs,
      timestampMs,
      sourceIndex,
    };
    this.options.onFrame?.(frame);
    if (this.options.wantedIndices === undefined || this.options.wantedIndices.has(sourceIndex)) {
      this.retained.push(frame);
    }
  }

  /**
   * 是否应当停止继续扫描。
   *
   * @param sourceIndex 刚处理完的帧序号。
   * @returns 需要停止时为 true。
   */
  private shouldStop(sourceIndex: number): boolean {
    const stopAfter = this.options.stopAfterIndex;
    if (stopAfter !== undefined && sourceIndex >= stopAfter) {
      return true;
    }
    const maxFrames = this.options.maxFrames;
    return maxFrames !== undefined && this.frameCount >= maxFrames;
  }

  /**
   * 归一化帧延迟（浏览器语义：过短延迟按 {@link SUBSTITUTE_DELAY_MS} 处理）。
   *
   * 为什么必须归一化：GIF 里延迟 <20ms 极常见（编码器把"尽可能快"写成 0 或 1cs），
   * 若按字面值累加，一部 100 帧的 GIF 会被算成 0ms 总时长 —— 时间线一旦塌陷，
   * 模型看到的「帧序」就失去了时间含义。
   *
   * @param rawMs 原始延迟（毫秒）。
   * @returns 归一化后的延迟（毫秒）。
   */
  private static normalizeDelay(rawMs: number): number {
    return rawMs < MIN_MEANINGFUL_DELAY_MS ? SUBSTITUTE_DELAY_MS : rawMs;
  }

  /**
   * 默认帧属性（无图形控制扩展时）。
   *
   * @returns 默认帧属性。
   */
  private static defaultControl(): PendingControl {
    return {
      delayMs: DEFAULT_FRAME_DELAY_MS,
      disposal: 0,
      transparentIndex: undefined,
    };
  }
}
