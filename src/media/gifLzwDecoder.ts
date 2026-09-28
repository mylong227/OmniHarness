import { MediaFormatError } from '../errors/mediaFormatError.js';
import type { GifLzwResult } from './gifTypes.js';

/** LZW 码表上限（GIF 规范固定 12 位码）。 */
const MAX_CODE = 4096;

/** 最小码长合法区间（GIF 规范：2–8；少数文件写出 9–11，解码器应容忍）。 */
const MIN_CODE_SIZE_LOWER = 2;
const MIN_CODE_SIZE_UPPER = 11;

/**
 * GIF LZW 解码器（变长码，LSB 优先，无「early change」偏移）。
 *
 * ## 为什么自己写而不是引依赖
 *
 * GIF 的 LZW 是**有界、封闭**的算法（码长 2–12 位，码表 ≤4096），实现量在百行量级；
 * 而引入一个图像库只为解 GIF，会把「看一帧图」变成整条依赖链的准入问题（D10 依赖准入）。
 * 本实现同时是 `ports/**` 之外的纯计算，可被单测逐位钉住。
 *
 * ## 关键实现点（都是真实 GIF 里会遇到的）
 *
 * 1. **码长增长时机**：新增一项后若 `nextCode === 1 << codeSize` 则码长 +1（上限 12）。
 *    这是 GIF 的约定，与 TIFF LZW 的「early change」不同，写反会让所有像素错位。
 * 2. **KwKwK 特例**：当读到的码恰好等于「下一个待分配码」时，输出串 = 上一串 + 上一串首字节。
 *    编码器在序列重复时会产生这种码，漏处理会直接判损坏。
 * 3. **数据子块已拼接**：本解码器只认连续比特流（子块边界由 {@link GifBinaryReader} 处理）。
 * 4. **截断容错**：码流提前结束不抛错，而是**如实标记** `complete:false`（主流浏览器同样容错），
 *    由上层决定是提示还是丢弃。
 */
export class GifLzwDecoder {
  /** 前缀码表（`-1` 表示已是根）。 */
  private readonly prefix = new Int32Array(MAX_CODE);
  /** 后缀字节表。 */
  private readonly suffix = new Uint8Array(MAX_CODE);
  /** 每个码对应的首字节（KwKwK 与字典扩展都需要）。 */
  private readonly firstIndex = new Uint8Array(MAX_CODE);
  /** 每个码对应串的长度。 */
  private readonly chainLength = new Int32Array(MAX_CODE);
  /** 输出缓冲（调色板索引）。 */
  private readonly output: Uint8Array;
  /** 输出游标。 */
  private outputPosition = 0;
  /** 下一个待分配的码值。 */
  private nextCode = 0;
  /** 当前码长（比特）。 */
  private codeSize = 0;
  /** 起始码长（最小码长 + 1），清空码表时复位到此值。 */
  private readonly initialCodeSize: number;
  /** 清空码。 */
  private readonly clearCode: number;
  /** 结束码。 */
  private readonly endCode: number;
  /** 比特缓冲（LSB 优先，最多累积 31 位）。 */
  private bitBuffer = 0;
  /** 比特缓冲中的有效位数。 */
  private bitCount = 0;
  /** 已消费的输入字节数。 */
  private bytePosition = 0;

  /**
   * @param expectedPixels 期望像素数（帧宽 × 帧高）。
   * @param minCodeSize LZW 最小码长（图像数据首字节）。
   */
  private constructor(
    expectedPixels: number,
    private readonly minCodeSize: number,
  ) {
    this.output = new Uint8Array(expectedPixels);
    this.clearCode = 1 << minCodeSize;
    this.endCode = this.clearCode + 1;
    this.initialCodeSize = minCodeSize + 1;
    for (let index = 0; index < this.clearCode; index += 1) {
      this.prefix[index] = -1;
      this.suffix[index] = index;
      this.firstIndex[index] = index;
      this.chainLength[index] = 1;
    }
    this.resetTable();
  }

  /**
   * 解码一整帧的调色板索引。
   *
   * @param data 已拼接的图像数据子块（LZW 压缩态）。
   * @param minCodeSize LZW 最小码长。
   * @param expectedPixels 期望像素数（帧宽 × 帧高）。
   * @returns 索引缓冲 + 是否完整。
   * @throws {MediaFormatError} 最小码长非法时（超出 2–11）。
   */
  public static decode(data: Buffer, minCodeSize: number, expectedPixels: number): GifLzwResult {
    if (minCodeSize < MIN_CODE_SIZE_LOWER || minCodeSize > MIN_CODE_SIZE_UPPER) {
      throw new MediaFormatError(`GIF LZW 最小码长非法: ${String(minCodeSize)}（合法区间 2–11）`);
    }
    return new GifLzwDecoder(expectedPixels, minCodeSize).run(data);
  }

  /**
   * 主循环。
   *
   * @param data 压缩数据。
   * @returns 索引缓冲 + 是否完整。
   */
  private run(data: Buffer): GifLzwResult {
    let previous = -1;
    for (;;) {
      const code = this.readCode(data);
      if (code < 0) {
        return this.finish(false);
      }
      if (code === this.clearCode) {
        this.resetTable();
        previous = -1;
        continue;
      }
      if (code === this.endCode) {
        return this.finish(true);
      }
      const next = this.consume(code, previous);
      if (next === undefined) {
        return this.finish(false);
      }
      previous = next;
    }
  }

  /**
   * 处理一个数据码（含 KwKwK 特例）。
   *
   * @param code 数据码。
   * @param previous 上一个数据码（`-1` 表示紧跟清空码之后）。
   * @returns 该码本身（供下一轮作 `previous`）；码流非法时返回 `undefined`。
   */
  private consume(code: number, previous: number): number | undefined {
    if (code < this.nextCode) {
      if (!this.emitChain(code)) {
        return undefined;
      }
      if (previous >= 0) {
        this.defineEntry(previous, this.firstIndex[code] ?? 0);
      }
      return code;
    }
    if (code === this.nextCode && previous >= 0) {
      const length = this.chainLength[previous] ?? 0;
      // 输出缓冲必须容得下「上一串 + 首字节」：不足即码流与声明的像素数不符。
      if (this.outputPosition + length + 1 > this.output.length) {
        return undefined;
      }
      if (!this.emitChain(previous)) {
        return undefined;
      }
      this.output[this.outputPosition] = this.firstIndex[previous] ?? 0;
      this.outputPosition += 1;
      this.defineEntry(previous, this.firstIndex[previous] ?? 0);
      return code;
    }
    return undefined;
  }

  /**
   * 取一个码（LSB 优先；输入耗尽时返回 -1）。
   *
   * @param data 压缩数据。
   * @returns 码值；输入耗尽时为 -1。
   */
  private readCode(data: Buffer): number {
    while (this.bitCount < this.codeSize) {
      if (this.bytePosition >= data.length) {
        return -1;
      }
      const byte = data[this.bytePosition] ?? 0;
      this.bytePosition += 1;
      this.bitBuffer |= byte << this.bitCount;
      this.bitCount += 8;
    }
    const code = this.bitBuffer & ((1 << this.codeSize) - 1);
    this.bitBuffer >>= this.codeSize;
    this.bitCount -= this.codeSize;
    return code;
  }

  /**
   * 输出某个码对应的串（逆序回溯前缀链后正序写入）。
   *
   * @param code 码值。
   * @returns 是否写入成功（输出溢出时为 false）。
   */
  private emitChain(code: number): boolean {
    const length = this.chainLength[code] ?? 0;
    if (this.outputPosition + length > this.output.length) {
      return false;
    }
    let cursor = this.outputPosition + length - 1;
    let current = code;
    while (current >= 0) {
      this.output[cursor] = this.suffix[current] ?? 0;
      cursor -= 1;
      current = this.prefix[current] ?? -1;
    }
    this.outputPosition += length;
    return true;
  }

  /**
   * 新增一个字典项（并在跨过码长边界时增长码长）。
   *
   * @param previous 前缀码。
   * @param first 首字节。
   * @returns 无返回值。
   */
  private defineEntry(previous: number, first: number): void {
    if (this.nextCode >= MAX_CODE) {
      return;
    }
    this.prefix[this.nextCode] = previous;
    this.suffix[this.nextCode] = first;
    this.firstIndex[this.nextCode] = this.firstIndex[previous] ?? first;
    this.chainLength[this.nextCode] = (this.chainLength[previous] ?? 1) + 1;
    this.nextCode += 1;
    if (this.nextCode === 1 << this.codeSize && this.codeSize < 12) {
      this.codeSize += 1;
    }
  }

  /**
   * 复位码表（读到清空码 / 开始时调用）。
   *
   * @returns 无返回值。
   */
  private resetTable(): void {
    this.nextCode = this.endCode + 1;
    this.codeSize = this.initialCodeSize;
  }

  /**
   * 收尾：给出结果与完整性判定。
   *
   * @param reachedEndCode 是否读到了结束码。
   * @returns 索引缓冲 + 是否完整。
   */
  private finish(reachedEndCode: boolean): GifLzwResult {
    return {
      indices: this.output,
      complete: reachedEndCode && this.outputPosition >= this.output.length,
    };
  }
}
