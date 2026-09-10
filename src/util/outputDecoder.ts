import { TextDecoder } from 'node:util';

/** 输出解码器：优先 UTF-8，出现替换符则回退 GBK（Windows 控制台码页）。 */
export class OutputDecoder {
  private readonly utf8 = new TextDecoder('utf-8');
  private readonly gbk = this.tryDecoder('gbk');

  /** 解码 Buffer。 */
  public decode(buffer: Buffer): string {
    const utf8Text = this.utf8.decode(buffer);
    if (!this.hasReplacement(utf8Text)) {
      return utf8Text;
    }
    if (this.gbk !== undefined) {
      return this.gbk.decode(buffer);
    }
    return utf8Text;
  }

  /** 是否含替换符。 */
  private hasReplacement(text: string): boolean {
    return text.includes('\uFFFD');
  }

  /** 尝试构造指定编码解码器（不支持则返回 undefined）。 */
  private tryDecoder(encoding: string): TextDecoder | undefined {
    try {
      return new TextDecoder(encoding);
    } catch {
      return undefined;
    }
  }
}
