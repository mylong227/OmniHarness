import type { TodoItem, TodoPort } from '../../ports/todo.js';

/** 内存待办端口：会话级整表快照，last-write-wins。 */
export class MemoryTodo implements TodoPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'）。 */
  public readonly name = 'memory';
  private items: readonly TodoItem[] = [];

  /** 以整表快照覆盖当前待办（会话级 last-write-wins，不增量合并）。 */
  public snapshot(items: readonly TodoItem[]): void {
    this.items = items.slice();
  }

  /** 返回当前待办快照（最近一次 snapshot 的副本）。 */
  public list(): readonly TodoItem[] {
    return this.items;
  }
}
