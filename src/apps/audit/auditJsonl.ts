/**
 * JSONL 读取器（审计解析器的共同入口）。
 *
 * 边界与失败语义：
 * - 跳过空行；坏行**计数但不中止**（会话文件可能在崩溃时留下半行，整份拒读会让
 *   "最后一次事故"恰好无法出证——这正是审计最需要的场景）；
 * - 行数上限 {@link AuditJsonl.MAX_LINES}：超过即**抛错**，不静默截断（截断的报告会
 *   让复核方以为"就这些"，比明确失败更危险）；
 * - 容忍 UTF-8 BOM（与配置解析口径一致）。
 */
export class AuditJsonl {
  /** 单文件最大行数（约等于一次会话的极端上限；超过说明输入不是会话文件）。 */
  public static readonly MAX_LINES = 100_000;

  /**
   * 逐行解析 JSON。
   * @param text 文件全文。
   * @returns 解析成功的值（保持行序）与坏行计数。
   * @throws Error 行数超过 {@link AuditJsonl.MAX_LINES} 时抛出。
   */
  public static parse(text: string): {
    readonly values: readonly unknown[];
    readonly badLines: number;
  } {
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const lines = normalized.split(/\r?\n/);
    if (lines.length > AuditJsonl.MAX_LINES) {
      throw new Error(
        `输入超过 ${String(AuditJsonl.MAX_LINES)} 行上限（${String(lines.length)} 行），` +
          '为防误读非会话文件已拒绝；请先切分出单次会话再出证。',
      );
    }
    const values: unknown[] = [];
    let badLines = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      try {
        values.push(JSON.parse(trimmed));
      } catch {
        badLines += 1;
      }
    }
    return { values, badLines };
  }

  /**
   * 安全地按对象读取一行（兼容 `{...}` 与包的 `[{...}]` 形态）。
   * @param value 解析后的值。
   * @returns 对象；非对象返回 null。
   */
  public static recordOf(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
