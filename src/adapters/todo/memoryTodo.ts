import type { TodoItem, TodoPort } from '../../ports/runtime/todo.js';

/**
 * 内存待办端口：**按会话分桶**的整表快照，last-write-wins。
 *
 * 为什么必须分会话（2026-09-26 审计 F7/F9）：本端口在组合根是进程级单例，而工具实例在注册期
 * 就闭包捕获了它。改造前只有一张整表 ⇒ 长跑 server 上所有会话共用同一份待办；更糟的是子代理
 * 的 `todo_write` 会把**父会话**的清单整表覆盖并向父事件流发通知（子代 runtime 自建的那份端口
 * 从未绑定任何工具，是死对象）。
 *
 * 分桶后：父会话说自己的话、子会话说自己的话，互不覆盖；「会话级 last-write-wins」在多会话下
 * 才真正成立。无 sessionId 的调用（库调用方 / 旧测试）走 `GLOBAL` 桶，行为与改造前一致。
 */
export class MemoryTodo implements TodoPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'）。 */
  public readonly name = 'memory';

  /**
   * 保留的会话桶上限（超出即按登记顺序淘汰最早的会话）。
   *
   * 依据：每个桶只是一份小数组；上限存在的意义是让「长跑 server 每见一个会话常驻一份」有界。
   */
  public static readonly MAX_SESSIONS = 256;

  /** 无会话归属时的桶键（保持库调用方的旧行为）。 */
  private static readonly GLOBAL = '';

  /** 会话桶：sessionId → 整表快照。 */
  private readonly buckets = new Map<string, readonly TodoItem[]>();

  /** 以整表快照覆盖指定会话的待办（last-write-wins，不增量合并）。
   * @param items 完整待办列表（内部拷贝一份，防外部后续突变）。
   * @param sessionId 会话 id（缺省为全局桶）。
   * @returns 无返回值。
   */
  public snapshot(items: readonly TodoItem[], sessionId?: string): void {
    const key = sessionId ?? MemoryTodo.GLOBAL;
    this.buckets.set(key, items.slice());
    this.evictIfNeeded();
  }

  /** 返回指定会话的当前待办快照。
   * @param sessionId 会话 id（缺省为全局桶）。
   * @returns 该会话的待办列表；从未 snapshot 过时为空数组。
   */
  public list(sessionId?: string): readonly TodoItem[] {
    return this.buckets.get(sessionId ?? MemoryTodo.GLOBAL) ?? [];
  }

  /**
   * 淘汰最早的会话桶（保持有界；全局桶不参与淘汰）。
   * @returns 无返回值。
   */
  private evictIfNeeded(): void {
    while (this.buckets.size > MemoryTodo.MAX_SESSIONS) {
      const oldest = this.buckets.keys().next();
      if (oldest.done === true) {
        return;
      }
      if (oldest.value === MemoryTodo.GLOBAL) {
        // 全局桶可能恰是最早的：先取出再放回，避免把它当牺牲品。
        const keep = this.buckets.get(MemoryTodo.GLOBAL);
        this.buckets.delete(MemoryTodo.GLOBAL);
        if (keep !== undefined) {
          this.buckets.set(MemoryTodo.GLOBAL, keep);
        }
        continue;
      }
      this.buckets.delete(oldest.value);
    }
  }
}
