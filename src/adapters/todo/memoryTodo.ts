import type { TodoItem, TodoPort } from '../../ports/todo.js';

/** 内存待办端口：会话级整表快照，last-write-wins。 */
export class MemoryTodo implements TodoPort {
  public readonly name = 'memory';
  private items: readonly TodoItem[] = [];

  public snapshot(items: readonly TodoItem[]): void {
    this.items = items.slice();
  }

  public list(): readonly TodoItem[] {
    return this.items;
  }
}
