/**
 * HTML → 纯文本（`web_fetch` 的正文提取，零依赖）。
 *
 * 为什么不用正则"删掉所有标签"了事：那样会把 `<script>`/`<style>` 的**内容**整段留下，
 * 网页里最大块的噪声（压缩后的 JS）反而最先涌进上下文。因此顺序是：
 * ① 先整块删掉 `script`/`style`/注释；② 把块级标签换成换行（保住段落感）；
 * ③ 抽出链接（`text (URL)`）与标题（`# 标题`）这类**语义信号**（不丢 href / 层级）；
 * ④ 剥掉剩余标签；⑤ 解实体码；⑥ 收敛空白。
 */

/** 整块丢弃的标签（内容也不保留）。 */
const DROPPED_BLOCKS = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** HTML 注释。 */
const COMMENTS = /<!--[\s\S]*?-->/g;

/** 标题起始标签（保留层级信号，h1→`# ` … h6→`###### `）。 */
const HEADING_START = /<h([1-6])\b[^>]*>/gi;

/** 需要制造换行的结束标签。 */
const BLOCK_END = /<\/(?:p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi;

/** 需要制造换行的起始标签（`br` / `hr` 无结束标签）。 */
const BREAK_START = /<(?:br|hr)\s*\/?>/gi;

/** 列表项前缀（保住"这是列表"的信号）。 */
const LIST_ITEM = /<li\b[^>]*>/gi;

/** 表单元格分隔。 */
const CELL = /<\/(?:td|th)\s*>/gi;

/** 链接：保留 href（仅 http/https，过滤 `javascript:` / 锚点）。 */
const LINK = /<a\b[^>]*?href=(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;

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
   * @returns 纯文本（块级结构保留为换行、链接与标题语义保留、实体已解码、连续空行已收敛）。
   */
  public static convert(html: string): string {
    let text = html
      .replace(COMMENTS, '')
      .replace(DROPPED_BLOCKS, ' ')
      .replace(HEADING_START, (_all, level: string) => `\n${'#'.repeat(Number(level))} `)
      .replace(LINK, (_all, _q: string, href: string, inner: string) =>
        HtmlToText.renderLink(href, inner),
      )
      .replace(BLOCK_END, '\n')
      .replace(BREAK_START, '\n')
      .replace(LIST_ITEM, '\n- ')
      .replace(CELL, ' | ')
      .replace(TAGS, '');
    text = HtmlToText.decodeEntities(text);
    return HtmlToText.collapse(text);
  }

  /**
   * 渲染链接：保留可见文本 + href（仅 http/https 这类可取用的绝对地址；
   * `javascript:` / `#锚点` 等无信息量链接只留文本，避免把噪声灌进上下文）。
   *
   * @param href 原始 href 属性值。
   * @param inner 标签内部原始内容（可能含子标签，最终会被统一剥离）。
   * @returns 渲染后的文本片段。
   */
  private static renderLink(href: string, inner: string): string {
    const trimmed = href.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return `${inner} (${trimmed})`;
    }
    return inner;
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
      .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
      .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
    return lines.join('\n').trim();
  }
}
