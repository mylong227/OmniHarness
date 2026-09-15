/**
 * 测试失败摘要提取（P3 自验证回环）。
 *
 * 回环只把**失败摘要**（非全量日志）回灌一步：全量测试日志动辄数千行，直接进上下文
 * 会挤占预算且淹没关键信号。本类从原始输出里抽出「失败行」并限行，命中不到失败行时
 * 回落到输出尾部（失败信息常在末尾汇总）。
 *
 * 覆盖 node --test / jest / vitest / pytest / cargo test 等常见形态（纯正则，零依赖）。
 */

/** 单行摘要的最大字符数（超长行截断，避免单行撑爆上下文）。 */
const MAX_LINE_CHARS = 300;

/** ANSI 颜色控制码（测试输出普遍带色，摘要里应剥掉）。 */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * 失败行判定（逐行匹配）。
 * 全部为**行首或明确失败标记**，避免把普通日志里的 "fail" 字样误当失败行。
 */
const FAIL_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*not ok\b/i,
  /^\s*✖/,
  /^\s*✗/,
  /^\s*FAIL(?:ED)?\b/,
  /\bAssertionError\b/,
  /^\s*(?:Error|TypeError|ReferenceError|SyntaxError|RangeError)\s*:/,
  /^\s*expected\b/i,
  /^\s*actual\b/i,
  /^\s*# fail\s+\d+/i,
  /^\s*Tests:\s+.*\bfailed\b/i,
  /^\s*\d+\s+(?:failing|failed)\b/i,
];

/** 判定单行是否为失败行。 */
const isFailLine = (line: string): boolean => FAIL_LINE_PATTERNS.some((re) => re.test(line));

/** 归一化单行：剥 ANSI、去行尾空白、超长截断。 */
const normalize = (line: string): string => {
  const clean = line.replace(ANSI, '').replace(/\r$/, '').trimEnd();
  return clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…` : clean;
};

/**
 * 失败摘要提取器（无状态，纯静态）。
 */
export class TestFailureDigest {
  /**
   * 从原始测试输出提取失败摘要。
   *
   * 策略：先取全部失败行（去重保序、限 `maxLines` 条）；一条失败行都没有时，
   * 回落到输出尾部 `maxLines` 条非空行（失败信息常在末尾汇总）。
   *
   * @param raw 原始输出（stdout + stderr 合并）。
   * @param maxLines 摘要行数上限（≤0 时取 1）。
   * @returns 摘要文本（输入为空时返回空串）。
   */
  public static from(raw: string, maxLines: number): string {
    const limit = maxLines > 0 ? maxLines : 1;
    const lines = raw.split('\n').map(normalize);
    const failures = [...new Set(lines.filter(isFailLine))].slice(0, limit);
    if (failures.length > 0) {
      return failures.join('\n');
    }
    const tail = lines.filter((l) => l.length > 0).slice(-limit);
    return tail.join('\n');
  }
}
