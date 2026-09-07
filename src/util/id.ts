/** 全局递增计数器（事件/会话/调用 ID 生成）。 */
let counter = 0;

/** 生成带时间戳前缀的短 ID。 */
export function id(prefix = 'evt'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
