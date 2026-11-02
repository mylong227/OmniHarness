/**
 * 报告渲染的格式化工具（HTML / Markdown 共用）。
 *
 * 所有输出都经过转义：报告正文来自**外部会话文件**（模型输出、命令、文件路径），
 * 直接拼进 HTML 会形成注入面。HTML 用实体转义，Markdown 表格转义 `|` 与换行。
 */
export class AuditFormatting {
  /** 时间线在 HTML/Markdown 里最多展示的条数（完整数据仍在载荷里）。 */
  public static readonly MAX_DISPLAY_RECORDS = 1000;

  /**
   * HTML 实体转义。
   * @param text 原始文本。
   * @returns 可安全嵌入 HTML 的文本。
   */
  public static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 把 JSON 文本安全嵌入 `<script type="application/json">`：转义 `<` `>` `&` 与行分隔符。
   * @param json JSON 文本。
   * @returns 可嵌入的文本。
   */
  public static embedJson(json: string): string {
    return json
      .replace(/&/g, '\\u0026')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  /**
   * 格式化毫秒时长（未知返回 `—`）。
   * @param ms 毫秒。
   * @returns 人类可读时长。
   */
  public static duration(ms: number | null): string {
    if (ms === null) {
      return '—';
    }
    if (ms < 1000) {
      return `${String(ms)} ms`;
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
      return `${String(seconds)} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) {
      return `${String(minutes)} 分 ${String(rest)} 秒`;
    }
    return `${String(Math.floor(minutes / 60))} 时 ${String(minutes % 60)} 分`;
  }

  /**
   * 千分位数字（null 返回 `—`）。
   * @param value 数字。
   * @returns 文本。
   */
  public static number(value: number | null): string {
    return value === null ? '—' : value.toLocaleString('en-US');
  }

  /**
   * 单行化 + 截断（表格单元格用）。
   * @param text 原始文本。
   * @param max 上限。
   * @returns 单行文本。
   */
  public static oneLine(text: string, max = 160): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
  }

  /**
   * Markdown 表格单元格转义（`|` 与换行）。
   * @param text 原始文本。
   * @returns 可嵌入表格的文本。
   */
  public static markdownCell(text: string): string {
    return AuditFormatting.oneLine(text, 200).replace(/\|/g, '\\|');
  }

  /**
   * 时间戳短形态（`2026-11-02T22:44:00.000Z` → `2026-11-02 22:44:00Z`）。
   * @param ts ISO 时间戳。
   * @returns 短形态；null 返回 `—`。
   */
  public static timestamp(ts: string | null): string {
    if (ts === null) {
      return '—';
    }
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts);
    return match === null ? ts : `${match[1] ?? ''} ${match[2] ?? ''}Z`;
  }

  /**
   * 把 HTML 表格里的正文包成可展开块（长文本不撑破布局）。
   * @param text 原始文本。
   * @returns HTML 片段。
   */
  public static detailHtml(text: string): string {
    const escaped = AuditFormatting.escapeHtml(text.trim());
    if (escaped === '') {
      return '<span class="muted">—</span>';
    }
    const preview = AuditFormatting.escapeHtml(AuditFormatting.oneLine(text, 180));
    return `<details><summary>${preview}</summary><pre>${escaped}</pre></details>`;
  }
}
