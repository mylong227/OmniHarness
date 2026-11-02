/**
 * 工具观测压缩（P5 · SWE-agent 式 ACI）。
 *
 * 目标不是「把输出变短」这么简单，而是**在有限预览里保住可行动信息**：
 * 错误/断言/异常行优先，其次头尾；完整内容仍由外溢器落盘，可 `spill_read` 读回。
 */

/** 压缩选项。 */
export interface ObservationPreviewOptions {
  /** 最多保留行数（默认 40）。 */
  readonly maxLines?: number;
  /** 最多字符数（默认 4000）。 */
  readonly maxChars?: number;
}

/** 错误/失败行匹配（不区分大小写）。 */
const ERROR_LINE =
  /(?:\berror\b|\bfail(?:ed|ure)?\b|\bassert(?:ion)?\b|\bexception\b|\btraceback\b|\bpanic\b|\bexpected\b|\breceived\b)/iu;

/** ANSI 控制序列（颜色/光标）。 */
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

/**
 * 把长工具输出压成「错误优先 + 头尾」的预览。
 */
export class ObservationCompressor {
  /**
   * 生成有界预览。
   * @param text 原始输出
   * @param options 行/字符预算
   * @returns 预览文本（含省略标记）
   */
  public static preview(text: string, options: ObservationPreviewOptions = {}): string {
    const maxLines = Math.max(4, Math.floor(options.maxLines ?? 40));
    const maxChars = Math.max(256, Math.floor(options.maxChars ?? 4_000));
    const clean = text.replace(ANSI, '');
    const lines = clean.split(/\r?\n/u);
    if (lines.length <= maxLines && clean.length <= maxChars) {
      return clean;
    }
    const head = lines.slice(0, Math.min(10, maxLines));
    const tail = lines.slice(-Math.min(10, maxLines));
    const errors = lines.filter((line) => ERROR_LINE.test(line)).slice(0, 20);
    const selected: string[] = [];
    for (const line of [...errors, ...head, ...tail]) {
      if (!selected.includes(line)) selected.push(line);
      if (selected.length >= maxLines) break;
    }
    const omitted = Math.max(0, lines.length - selected.length);
    const marker = omitted > 0 ? `…（省略 ${String(omitted)} 行；完整内容见 spill）` : '';
    return ObservationCompressor.clip(
      [...selected, marker].filter((line) => line !== '').join('\n'),
      maxChars,
    );
  }

  /**
   * 按字符预算截断（保留头尾）。
   * @param text 文本
   * @param maxChars 预算
   * @returns 截断文本
   */
  private static clip(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 0.7);
    const tail = maxChars - head - 20;
    return `${text.slice(0, head)}\n…（预览截断）…\n${tail > 0 ? text.slice(-tail) : ''}`;
  }
}
