import { MediaFormatError } from '../errors/mediaFormatError.js';

/**
 * GIF 字节游标读取器：小端整数、定长字符串、数据子块。
 *
 * 为什么单独一层：GIF 是**块结构**格式，读取逻辑（越界即报错、子块扫描）在每个解析点都要用；
 * 若各处自己 `slice`，一旦有处漏判越界就会读到 `undefined` 并静默产出错误像素。
 * 本类把「越界」统一变成带偏移的 `MediaFormatError`——**损坏必须响亮**，不能悄悄出图。
 */
export class GifBinaryReader {
  /** 当前读取位置（字节偏移）。 */
  private cursor = 0;

  /**
   * @param bytes 完整文件字节。
   */
  public constructor(private readonly bytes: Buffer) {}

  /** 当前读取位置。 */
  public get position(): number {
    return this.cursor;
  }

  /** 剩余可读字节数。 */
  public get remaining(): number {
    return this.bytes.length - this.cursor;
  }

  /**
   * 读 1 字节无符号整数。
   *
   * @returns 0–255。
   */
  public readUInt8(): number {
    this.ensure(1, '无符号字节');
    const value = this.bytes[this.cursor] ?? 0;
    this.cursor += 1;
    return value;
  }

  /**
   * 读 2 字节小端无符号整数。
   *
   * @returns 0–65535。
   */
  public readUInt16LE(): number {
    this.ensure(2, '小端 16 位整数');
    const value = this.bytes.readUInt16LE(this.cursor);
    this.cursor += 2;
    return value;
  }

  /**
   * 读定长 ASCII 字符串。
   *
   * @param length 字符数。
   * @returns ASCII 字符串。
   */
  public readString(length: number): string {
    this.ensure(length, '定长字符串');
    const value = this.bytes.toString('ascii', this.cursor, this.cursor + length);
    this.cursor += length;
    return value;
  }

  /**
   * 读定长字节块。
   *
   * @param length 字节数。
   * @returns 字节块（副本）。
   */
  public readBytes(length: number): Buffer {
    this.ensure(length, '定长字节块');
    const value = Buffer.from(this.bytes.subarray(this.cursor, this.cursor + length));
    this.cursor += length;
    return value;
  }

  /**
   * 跳过若干字节。
   *
   * @param length 字节数。
   * @returns 无返回值。
   */
  public skip(length: number): void {
    this.ensure(length, '跳过区间');
    this.cursor += length;
  }

  /**
   * 读取一串数据子块并**拼接**成一个缓冲（遇到长度 0 的终止子块即结束）。
   *
   * @returns 拼接后的子块内容（可能为空缓冲）。
   */
  public readSubBlocks(): Buffer {
    const parts: Buffer[] = [];
    for (;;) {
      const size = this.readUInt8();
      if (size === 0) {
        break;
      }
      parts.push(this.readBytes(size));
    }
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }

  /**
   * 跳过一个数据子块链（不保留内容，用于注释 / 纯文本 / 不关心的帧数据）。
   *
   * @returns 无返回值。
   */
  public skipSubBlocks(): void {
    for (;;) {
      const size = this.readUInt8();
      if (size === 0) {
        return;
      }
      this.skip(size);
    }
  }

  /**
   * 断言剩余可读字节充足。
   *
   * @param length 需要的字节数。
   * @param what 出错时的语义名（用于错误文案）。
   * @returns 无返回值。
   */
  private ensure(length: number, what: string): void {
    if (length < 0 || this.cursor + length > this.bytes.length) {
      throw new MediaFormatError(
        `GIF 数据在偏移 ${String(this.cursor)} 处截断：需要 ${String(length)} 字节读取${what}，` +
          `但仅剩 ${String(this.remaining)} 字节`,
        this.cursor,
      );
    }
  }
}
