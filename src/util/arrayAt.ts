/**
 * 类型安全的数组索引访问，用于已启用 `noUncheckedIndexedAccess` 的代码。
 *
 * 在该严格标志下，原生 `xs[i]` 的返回值类型恒为 `T | undefined`，即便索引
 * 在循环边界内、运行时必然合法（例如以 `xs.length` 为界的循环变量）。`at`
 * 把结果收窄回 `T`，并在索引越界时抛出一个带上下文的 `RangeError`，
 * 而不是把 `undefined` 静默地向下游传播（后者往往要在 `.field` 访问或算术
 * 运算处才以难以定位的 `TypeError` 崩溃）。
 *
 * 本函数是显式运行时检查，不是类型逃逸：它用控制流收窄替代 `!` 断言，
 * 因此可在 `noUncheckedIndexedAccess` 下消除大量「下标恒合法」场景里的
 * 非空断言，同时保持语义不变（越界时同样会失败，只是更早、信息更明确）。
 *
 * 入参为 `ArrayLike<T>`，因此 `T[]` / `readonly T[]` / 类型化数组
 * （`Float64Array` 等）/ `string` / 元组均可传入，统一把索引结果收窄回 `T`。
 *
 * @typeParam T - 元素类型
 * @param xs - 被索引的数组 / 类型化数组 / 字符串 / 只读视图（满足 `ArrayLike<T>`）
 * @param index - 数值下标
 * @returns 下标 `index` 处的元素，类型收窄为 `T`（绝不为 `undefined`）
 * @throws {RangeError} 当 `index` 落在 `[0, xs.length)` 之外时
 */

/**
 * ArrayAt —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class ArrayAt {
  /**
   * 越界即抛错的数组取值（取代 `xs[i]!` 之类的非空断言）。
   * @param xs 数组或类数组。
   * @param index 下标。
   * @returns 该下标的元素（类型收窄为 `T`，不含 `undefined`）。
   * @throws RangeError 当 `xs[index]` 为 `undefined`（越界）。
   */
  public static at<T>(xs: ArrayLike<T>, index: number): T {
    const value = xs[index];
    if (value === undefined) {
      throw new RangeError(`array index out of range: ${index} (length ${xs.length})`);
    }
    return value;
  }
}
