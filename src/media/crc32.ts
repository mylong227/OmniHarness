/**
 * CRC-32（IEEE 802.3 多项式 `0xEDB88320`，PNG 块校验用）。
 *
 * 为什么自己实现（而不是用 Node 的 `zlib.crc32`）：`zlib.crc32` 需要 Node ≥ 22.2 才存在，
 * 而 CRC 表是 20 行就能确定的常量表——自己算既免掉运行时版本判定的分支，
 * 又让 PNG 编码器在任何 Node 22.x 上都产出**逐字节一致**的文件（同一输入恒同一字节，
 * 便于测试与内容寻址）。表在建类时一次性生成（256 项，可忽略成本）。
 */
export class Crc32 {
  /** 预生成的查找表（首次使用时构建一次）。 */
  private static table: Uint32Array | undefined = undefined;

  /**
   * 计算一段字节的 CRC-32。
   *
   * @param bytes 源字节。
   * @param start 起始偏移（含，缺省 0）。
   * @param end 结束偏移（不含，缺省到末尾）。
   * @returns 32 位无符号校验值。
   */
  public static of(bytes: Uint8Array, start = 0, end = bytes.length): number {
    const table = Crc32.ensureTable();
    let crc = 0xffffffff;
    for (let index = start; index < end; index += 1) {
      const slot = (crc ^ (bytes[index] ?? 0)) & 0xff;
      crc = (crc >>> 8) ^ (table[slot] ?? 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * 取（必要时构建）查找表。
   *
   * @returns 256 项查找表。
   */
  private static ensureTable(): Uint32Array {
    if (Crc32.table !== undefined) {
      return Crc32.table;
    }
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    Crc32.table = table;
    return table;
  }
}
