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

  /** 生成预览：保留头部，天然短内容原样返回。 */
  public preview(content: string): string {
    const limit = this.options.previewBytes;
    if (this.byteLength(content) <= limit) {
      return content;
    }
    return content.slice(0, limit);
  }

  /** UTF-8 字节长度。 */
  public byteLength(content: string): number {
    return Buffer.byteLength(content, 'utf8');
  }
}
