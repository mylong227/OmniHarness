/**
 * 解析期的取值与边界工具（审计解析器共用）。
 *
 * 所有会话格式都是**外部输入**：字段可能缺失、类型可能不对、文本可能极大。本类只做两件事：
 * 1. 安全取值（形状不符返回 null，绝不抛错、绝不猜）；
 * 2. 硬上限（单条文本 {@link AuditValues.MAX_TEXT_CHARS}、meta 字符串
 *    {@link AuditValues.MAX_META_STRING}）——报告是给人读的，不是日志转储。
 */
export class AuditValues {
  /** 单条记录正文的字符上限；超出部分截断并标注省略量。 */
  public static readonly MAX_TEXT_CHARS = 8000;

  /** meta 里单个字符串字段的上限。 */
  public static readonly MAX_META_STRING = 500;

  /**
   * 收窄为普通对象。
   * @param value 待判值。
   * @returns 普通对象；数组 / null / 标量返回 null。
   */
  public static record(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  /**
   * 取数组（形状不符返回空数组）。
   * @param value 待判值。
   * @returns 只读数组。
   */
  public static array(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
  }

  /**
   * 取字符串字段。
   * @param record 对象。
   * @param key 字段名。
   * @returns 非空字符串；缺失 / 非字符串 / 全空白返回 null。
   */
  public static stringField(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      return null;
    }
    return value;
  }

  /**
   * 取数字字段。
   * @param record 对象。
   * @param key 字段名。
   * @returns 有限数字；缺失 / 非数字返回 null。
   */
  public static numberField(record: Record<string, unknown>, key: string): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /**
   * 取布尔字段。
   * @param record 对象。
   * @param key 字段名。
   * @returns 布尔值；缺失 / 非布尔返回 null。
   */
  public static boolField(record: Record<string, unknown>, key: string): boolean | null {
    const value = record[key];
    return typeof value === 'boolean' ? value : null;
  }

  /**
   * 按顺序取第一个非空字符串字段。
   * @param record 对象。
   * @param keys 候选字段名（按优先级）。
   * @returns 第一个命中的字符串；全不命中返回 null。
   */
  public static firstString(
    record: Record<string, unknown>,
    keys: readonly string[],
  ): string | null {
    for (const key of keys) {
      const hit = AuditValues.stringField(record, key);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }

  /**
   * 把消息内容（字符串或多段块）压成纯文本。
   *
   * 支持的块形状：`{text}`、`{content}`、`{type:'text'|'input_text'|'output_text', text}`；
   * 其它块（图片、tool_use 等）跳过——它们有各自的结构化处理，不塞进正文。
   * @param value 内容字段。
   * @returns 纯文本；无可读文本返回 null。
   */
  public static text(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.trim() === '' ? null : value;
    }
    const blocks = AuditValues.array(value);
    if (blocks.length === 0) {
      return null;
    }
    const parts: string[] = [];
    for (const block of blocks) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      const record = AuditValues.record(block);
      if (record === null) {
        continue;
      }
      const type = AuditValues.stringField(record, 'type');
      if (
        type !== null &&
        ['text', 'input_text', 'output_text', 'summary_text'].indexOf(type) < 0
      ) {
        continue;
      }
      const text =
        AuditValues.stringField(record, 'text') ?? AuditValues.stringField(record, 'content');
      if (text !== null) {
        parts.push(text);
      }
    }
    const joined = parts.join('\n').trim();
    return joined === '' ? null : joined;
  }

  /**
   * 截断文本到上限，并标注省略量。
   * @param text 原文。
   * @param max 上限（缺省 {@link AuditValues.MAX_TEXT_CHARS}）。
   * @returns 截断后的文本。
   */
  public static truncate(text: string, max: number = AuditValues.MAX_TEXT_CHARS): string {
    if (text.length <= max) {
      return text;
    }
    const omitted = text.length - max;
    return `${text.slice(0, max)}\n…[已截断 ${String(omitted)} 字符]`;
  }

  /**
   * 把值压成一行可读摘要（用于工具调用参数 / 计划条目）。
   * @param value 任意解析出的值。
   * @returns JSON 文本（受 {@link AuditValues.MAX_TEXT_CHARS} 限制）；空值返回空串。
   */
  public static describe(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (!Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 0) {
      return '';
    }
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
    return AuditValues.truncate(text ?? '');
  }
}
