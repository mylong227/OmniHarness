/**
 * 记忆「值槽」判定（2026-10-28）。
 *
 * 解决的问题：`ResonantFieldEngine.remember` 用频谱共振做 Burgers 黏附去重，阈值 0.75 只反映
 * **词面相近**，不区分「同一槽位的不同取值」。于是「生产端口是 58217」之后写入「…是 58218」，
 * 新事实会被并入簇而**不落盘**，`remember` 工具仍回 `stored:true`——更正永久丢失，recall 继续返回旧值。
 *
 * 值槽 = 把文本里的数字/版本号替换成占位符后的骨架。骨架相同、原文不同 ⇒ 同一槽位的冲突取值。
 * 只做确定性字符串运算，不调用模型，可离线判死。
 */
export class MemoryValueSlot {
  /**
   * 归一化：去首尾空白、转小写、把标点/连续空白压成单个空格。
   * @param text 原始文本。
   * @returns 归一化文本。
   */
  public static normalize(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, ' ')
      .trim();
  }

  /**
   * 值槽骨架：把数字与版本号（`58217` / `1.2.3` / `2026-10-28`）替换为 `#`。
   * @param text 原始文本。
   * @returns 骨架文本。
   */
  public static slotOf(text: string): string {
    return MemoryValueSlot.normalize(text).replace(/\d+(?:[.:/-]\d+)*/gu, '#');
  }

  /**
   * 两条事实是否**同一槽位、不同取值**（互补冲突）。
   *
   * 要求归一化原文不同，避免把完全相同的事实误判成冲突（那会反复 expire 自己）。
   * @param a 事实 A 文本。
   * @param b 事实 B 文本。
   * @returns 同槽位且取值不同返回 true。
   */
  public static conflicts(a: string, b: string): boolean {
    const na = MemoryValueSlot.normalize(a);
    const nb = MemoryValueSlot.normalize(b);
    return na !== nb && MemoryValueSlot.slotOf(na) === MemoryValueSlot.slotOf(nb);
  }
}
