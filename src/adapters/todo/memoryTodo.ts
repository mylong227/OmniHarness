import type { TodoItem, TodoPort } from '../../ports/todo.js';

/** 内存待办端口：会话级整表快照，last-write-wins。 */
export class MemoryTodo implements TodoPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'）。 */
  public readonly name = 'memory';
  /** 当前待办整表（最近一次 snapshot 的内容，只读引用）。 */
  private items: readonly TodoItem[] = [];

  /** 以整表快照覆盖当前待办（会话级 last-write-wins，不增量合并）。
   * @param items 完整待办列表（内部拷贝一份，防外部后续突变）。
   */
  public snapshot(items: readonly TodoItem[]): void {
    this.items = items.slice();
  }

  /** 返回当前待办快照（最近一次 snapshot 的副本）。
   * @returns 当前待办列表；从未 snapshot 过时为空数组。
   */
  public list(): readonly TodoItem[] {
    return this.items;
  }
}
