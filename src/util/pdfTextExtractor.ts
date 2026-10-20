import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

/**
 * PDF 文本提取（ACT-03，2026-10-20）。
 *
 * 无第三方依赖的**尽力**提取：解 FlateDecode 流 + 抠 `Tj`/`TJ` 文本算子。
 * 它不是完整 PDF 引擎：扫描件（纯图片）、对象流、复杂编码会提取为空——此时调用方
 * 必须如实告诉模型“这是扫描件/提取失败”，不能把空串当正文。
 */
export class PdfTextExtractor {
  /**
   * 从 PDF 字节中提取文本（ACT-03）。
   *
   * 优先走可选依赖 `unpdf`（PDF.js 文本层，覆盖对象流/CMap/字体编码等真实 PDF）；
   * 未安装、加载失败或提取为空时，回退到零依赖正则实现。
   * @param buffer PDF 原始字节。
   * @returns 提取到的文本（可能为空串）。
   */
  public static async extractAsync(buffer: Buffer): Promise<string> {
    const advanced = await PdfTextExtractor.extractWithUnpdf(buffer);
    return advanced !== undefined && advanced !== '' ? advanced : PdfTextExtractor.extract(buffer);
  }

  /**
   * 可选增强：用 `unpdf` 提取；缺失/失败/空文本时返回 undefined（由调用方回退）。
   * @param buffer PDF 原始字节。
   * @returns 文本或 undefined。
   */
  private static async extractWithUnpdf(buffer: Buffer): Promise<string | undefined> {
    try {
      const require = createRequire(import.meta.url);
      const { extractText } = require('unpdf') as {
        extractText: (
          data: Uint8Array,
          options: { mergePages: true },
        ) => Promise<{ totalPages: number; text: string }>;
      };
      const result = await extractText(new Uint8Array(buffer), { mergePages: true });
      const text = result.text.replace(/\n{3,}/g, '\n\n').trim();
      return text === '' ? undefined : text;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 PDF 字节中提取文本。
   * @param buffer PDF 原始字节。
   * @returns 提取到的文本（可能为空串）。
   */
  public static extract(buffer: Buffer): string {
    const raw = buffer.toString('latin1');
    const parts: string[] = [];
    const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match: RegExpExecArray | null;
    while ((match = streamPattern.exec(raw)) !== null) {
      const header = raw.slice(Math.max(0, match.index - 300), match.index);
      let data = Buffer.from(match[1] ?? '', 'latin1');
      if (/\/FlateDecode/.test(header)) {
        try {
          data = inflateSync(data);
        } catch {
          continue;
        }
      }
      const text = PdfTextExtractor.fromContentStream(data.toString('latin1'));
      if (text !== '') parts.push(text);
    }
    return parts
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 从内容流里抠出 `Tj` / `TJ` 文本。
   * @param stream 内容流（latin1 解码）。
   * @returns 文本。
   */
  private static fromContentStream(stream: string): string {
    const out: string[] = [];
    for (const match of stream.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g)) {
      out.push(PdfTextExtractor.decode(match[0].replace(/\)\s*Tj$/, '').slice(1)));
    }
    for (const match of stream.matchAll(/\[(.*?)\]\s*TJ/gs)) {
      const inner = match[1] ?? '';
      for (const piece of inner.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
        out.push(PdfTextExtractor.decode(piece[0].slice(1, -1)));
      }
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * 解码 PDF 字符串转义（`\n` / 括号 / 八进制）。
   * @param text 原始字符串。
   * @returns 解码文本。
   */
  private static decode(text: string): string {
    return text
      .replace(/\\([nrtbf()\\])/g, (_all, ch: string) => {
        const map: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          b: '\b',
          f: '\f',
          '(': '(',
          ')': ')',
          '\\': '\\',
        };
        return map[ch] ?? ch;
      })
      .replace(/\\([0-7]{1,3})/g, (_all, oct: string) =>
        String.fromCharCode(Number.parseInt(oct, 8)),
      );
  }
}
