/**
 * UTF-8 BOM 处理（配置读取的**唯一**实现）。
 *
 * 为什么单列：`ConfigFile.readStrict` 与工作区信任闸都要读同一份 JSON；两边各写一份
 * `charCodeAt(0) === 0xfeff` 时，任何一边漏掉都会出现「实际加载了、信任决策却没看见」
 * 的绕过（2026-10-22 评审实测：BOM 项目配置可绕过 restricted）。
 */
export class TextBom {
  /**
   * 剥掉开头的 UTF-8 BOM（`\uFEFF`）。
   * @param text 原始文本。
   * @returns 去掉起始 BOM 的文本（无 BOM 时原样）。
   */
  public static strip(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}
