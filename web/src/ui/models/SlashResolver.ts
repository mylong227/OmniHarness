/**
 * 输入框 `/` 技能触发解析（零 React，可单测）。
 *
 * 只在行首或空白后触发；`http://`、路径 `src/a` 等不应弹出技能列表。
 * 返回的 `start` 指向 `/` 的下标，`query` 是 `/` 后的非空白片段。
 */
export interface SlashToken {
  /** `/` 在全文中的下标。 */
  readonly start: number;
  /** `/` 后的查询串（可能为空）。 */
  readonly query: string;
}

/** `/` 触发解析器。 */
export class SlashResolver {
  private constructor() {}

  /**
   * 解析光标前的 `/` 触发。
   * @param text 输入框全文
   * @param caret 光标下标
   * @returns 触发信息；未触发为 null
   */
  public static parse(text: string, caret: number): SlashToken | null {
    const pos = Math.max(0, Math.min(caret, text.length));
    const before = text.slice(0, pos);
    const match = /(^|\s)\/([^\s/]*)$/u.exec(before);
    if (match === null) return null;
    const start = before.lastIndexOf('/');
    return { start, query: match[2] ?? '' };
  }

  /**
   * 按查询串过滤技能（名称/描述/标签，大小写不敏感）。
   * @param items 技能清单
   * @param query 查询串
   * @returns 过滤后的清单（保持原顺序）
   */
  public static filter<T extends { name: string; description?: string; tags?: readonly string[] }>(
    items: readonly T[],
    query: string,
  ): T[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [...items];
    return items.filter((item) => {
      const hay = [item.name, item.description ?? '', ...(item.tags ?? [])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  /**
   * 把 `/query` 替换为 `/${name} `，返回新文本与光标位置。
   * @param text 原文
   * @param token 触发信息
   * @param name 选中的技能名
   * @param caret 当前光标
   * @returns 新文本与光标
   */
  public static apply(
    text: string,
    token: SlashToken,
    name: string,
    caret: number,
  ): { text: string; caret: number } {
    const pos = Math.max(0, Math.min(caret, text.length));
    const after = text.slice(pos);
    // 光标后已有空白时不再补空格，避免 `/review  修复` 双空格。
    const inserted = `/${name}${after.startsWith(' ') ? '' : ' '}`;
    const next = text.slice(0, token.start) + inserted + after;
    return { text: next, caret: token.start + inserted.length };
  }
}
