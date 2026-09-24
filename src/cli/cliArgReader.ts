/**
 * CLI 参数读取器（CliArgReader）——把「取标志值 / 位置参数」这类纯参数解析从命令继承链中解耦出来，
 * 以**组合**方式供各命令协作者复用（原为 CliBuildConfig 的 protected 方法）。
 *
 * 设计要点：
 *  - 纯读取、零依赖、无副作用，可单测（见 tests/unit/cliArgReader.test.ts）。
 *  - CliBuildConfig 的同名方法（flagValue / flagNumber / collectFlags）委托本类，保证**单一实现来源**，
 *    避免两套解析逻辑漂移；继承链上的 89+ 处既有调用点零改动。
 */

/** 只读参数读取器（构造时绑定参数数组，不持有可变状态）。 */
export class CliArgReader {
  /** 构造时绑定的命令行参数数组（只读，之后不再变更）。 */
  private readonly args: readonly string[];

  /**
   * @param args 命令行参数（通常已去掉程序名，首元素可能是子命令）。
   */
  public constructor(args: readonly string[]) {
    this.args = args;
  }

  /**
   * 取第 index 个位置参数（0 = 子命令本身）。
   * @param index 下标。
   * @returns 该位置参数；越界返回 undefined。
   */
  public at(index: number): string | undefined {
    return this.args[index];
  }

  /**
   * 取标志后的第一个值。
   * @param flag 标志名（如 `--file`）。
   * @returns 紧随其后的值；标志不存在或其后无值时返回 undefined。
   */
  public value(flag: string): string | undefined {
    const index = this.args.indexOf(flag);
    return index >= 0 ? this.args[index + 1] : undefined;
  }

  /**
   * 取数字标志值（十进制整数）。
   * @param flag 标志名。
   * @returns 解析后的整数；标志缺失返回 undefined（值非法时为 parseInt 的 NaN，与原行为一致）。
   */
  public number(flag: string): number | undefined {
    const value = this.value(flag);
    return value === undefined ? undefined : Number.parseInt(value, 10);
  }

  /**
   * 标志是否出现（布尔开关）。
   *
   * 语义上等价于 `args.includes(flag)`（`Array.includes` 本就是**精确元素匹配**，不存在子串误判）；
   * 之所以提供本方法，是为了让「子命令自行解析参数」的地方与 `value` / `number` / `values`
   * 用**同一套读取惯例**，而不是各写一行裸 `includes`（后者在 `--auth-required` 这类
   * **安全开关**上不易被检索与统一改造）。
   * @param flag 标志名（如 `--auth-required`）。
   * @returns 数组中存在完整等于该标志的元素时为 true。
   */
  public has(flag: string): boolean {
    return this.args.includes(flag);
  }

  /**
   * 收集可重复标志的全部取值（如 `--allow a --allow b`），跳过无值的尾随标志。
   * @param flag 标志名。
   * @returns 取值列表（可能为空）。
   */
  public values(flag: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < this.args.length; i += 1) {
      if (this.args[i] === flag) {
        const value = this.args[i + 1];
        if (value !== undefined) {
          values.push(value);
        }
      }
    }
    return values;
  }
}
