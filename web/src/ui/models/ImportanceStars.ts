// 重要度星级渲染：把 1–5 的重要度渲染成 ★/☆ 字符串。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 星级条渲染器。 */
export class ImportanceStars {
  /** 星级上限（与 UI 表单一一对应）。 */
  static readonly MAX = 5;

  /** 渲染：实心星 + 空心星补齐到 5；越界（负数 / 超过 5）一律夹紧，不抛错。 */
  static render(importance: number): string {
    const n = Number.isFinite(importance) ? Math.trunc(importance) : 0;
    const filled = Math.min(ImportanceStars.MAX, Math.max(0, n));
    return '★'.repeat(filled) + '☆'.repeat(ImportanceStars.MAX - filled);
  }
}
