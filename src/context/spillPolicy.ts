/**
 * @beta
 * 外溢策略参数。
 */
export interface SpillPolicyOptions {
  /** 输出 UTF-8 字节数超过此值则外溢。 */
  readonly maxInlineBytes: number;
  /** 预览保留的字节数。 */
  readonly previewBytes: number;
}

/**
 * @beta
 * 外溢策略：判定是否外溢 + 生成有界预览（纯逻辑，无 IO，便于单测）。
 */
export class SpillPolicy {
  public constructor(private readonly options: SpillPolicyOptions) {}

  /** 是否需要外溢（空内容不外溢）。 */
  public needsSpill(content: string | undefined): boolean {
    if (content === undefined) {
      return false;
    }
    return this.byteLength(content) > this.options.maxInlineBytes;
  }

  /** 生成预览：保留头部、**按 UTF-8 字节**截断，天然短内容原样返回。
   *
   * 2026-09-22 修（审计 P3）：原实现 `content.slice(0, previewBytes)` 按 **UTF-16 码元**切，
   * 而参数语义是字节 ⇒ CJK/emoji 内容实际预览可达预算的约 4 倍（「有界」不成立）。
   * 现改为字节截断，并回退到合法 UTF-8 字符边界（不产生半个字符）。
   * @param content 原始文本
   * @returns 预览文本（字节数 ≤ previewBytes）
   */
  public preview(content: string): string {
    const limit = this.options.previewBytes;
    const buf = Buffer.from(content, 'utf8');
    if (buf.length <= limit) {
      return content;
    }
    let end = limit;
    // 若截断点上落在「续字节」（10xxxxxx），说明该字符被切成半个 ⇒ 退回其首字节位置。
    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    return buf.subarray(0, end).toString('utf8');
  }

  /** UTF-8 字节长度。 */
  public byteLength(content: string): number {
    return Buffer.byteLength(content, 'utf8');
  }
}
