/**
 * HTML → 纯文本（`web_fetch` 的正文提取，零依赖）。
 *
 * 为什么不用正则"删掉所有标签"了事：那样会把 `<script>`/`<style>` 的**内容**整段留下，
 * 网页里最大块的噪声（压缩后的 JS）反而最先涌进上下文。因此顺序是：
 * ① 先整块删掉 `script`/`style`/注释；② 把块级标签换成换行（保住段落感）；
 * ③ 剥掉剩余标签；④ 解实体码；⑤ 收敛空白。
 */

/** 整块丢弃的标签（内容也不保留）。 */
const DROPPED_BLOCKS = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** HTML 注释。 */
const COMMENTS = /<!--[\s\S]*?-->/g;

/** 需要制造换行的结束标签。 */
const BLOCK_END = /<\/(?:p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi;

/** 需要制造换行的起始标签（`br` / `hr` 无结束标签）。 */
const BREAK_START = /<(?:br|hr)\s*\/?>/gi;

/** 列表项前缀（保住"这是列表"的信号）。 */
const LIST_ITEM = /<li\b[^>]*>/gi;

/** 表单元格分隔。 */
const CELL = /<\/(?:td|th)\s*>/gi;

/** 其余所有标签。 */
const TAGS = /<[^>]*>/g;

/** 常见命名实体。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

/**
 * HTML 转文本（无状态，纯静态）。
 */
export class HtmlToText {
  /**
   * 提取 HTML 的可读文本。
   *
   * @param html 原始 HTML 片段。
   * @returns 纯文本（块级结构保留为换行、实体已解码、连续空行已收敛）。
   */
  public static convert(html: string): string {
    let text = html
      .replace(COMMENTS, '')
      .replace(DROPPED_BLOCKS, ' ')
      .replace(BLOCK_END, '\n')
      .replace(BREAK_START, '\n')
      .replace(LIST_ITEM, '\n- ')
      .replace(CELL, ' | ')
      .replace(TAGS, '');
    text = HtmlToText.decodeEntities(text);
    return HtmlToText.collapse(text);
  }

  /**
   * 解码实体（命名实体表 + 数字/十六进制实体）。
   *
   * @param text 含实体的文本。
   * @returns 解码后的文本。
   */
  private static decodeEntities(text: string): string {
    return text
      .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) =>
        HtmlToText.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_all, dec: string) =>
        HtmlToText.fromCodePoint(Number.parseInt(dec, 10)),
      )
      .replace(/&[a-z]+;/gi, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity);
  }

  /**
   * 码点转字符（越界/非法时返回空串，绝不抛错）。
   *
   * @param code 码点。
   * @returns 对应字符。
   */
  private static fromCodePoint(code: number): string {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
      return '';
    }
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  }

  /**
   * 收敛空白：逐行去尾空白、压缩行内连续空格、连续空行最多保留一个。
   *
   * @param text 已剥标签的文本。
   * @returns 规整后的文本。
   */
  private static collapse(text: string): string {
    const lines = text
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
    return lines.join('\n').trim();
  }
}
