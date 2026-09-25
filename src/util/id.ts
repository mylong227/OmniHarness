/** 全局递增计数器（事件/会话/调用 ID 生成）。 */

/**
 * Id —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class Id {
  /** 生成带时间戳前缀的短 ID。 */
  public static id(prefix = 'evt'): string {
    counter += 1;
    return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
  }
}

let counter = 0;
