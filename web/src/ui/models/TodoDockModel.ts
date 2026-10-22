/** 一条待办（与 `todo` 事件载荷一致）。 */
export interface TodoDockItem {
  /** 任务文本。 */
  readonly content: string;
  /** 状态：pending / in_progress / completed。 */
  readonly status: string;
}

/** 面板需要的最小事件形状（不依赖后端类型，避免 web 包反向 import src）。 */
export interface TodoEventLike {
  /** 事件类型。 */
  readonly type: string;
  /** 事件载荷（历史事件可能缺省）。 */
  readonly payload?: unknown;
}

/**
 * 从事件流提取**最新**一条 todo 快照。
 *
 * 为什么取最新而不是拼接：`todo_write` 是整表替换语义，旧快照只代表历史状态；
 * 面板只应展示当前计划，否则完成项会重复计数。
 */
export class TodoDockModel {
  /**
   * 取最新待办快照。
   * @param events 会话事件（按数组顺序扫描）。
   * @returns 最新待办；从未写过返回 null。
   */
  public static latest(events: readonly TodoEventLike[]): readonly TodoDockItem[] | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'todo') continue;
      const raw = (event.payload as { readonly todos?: unknown } | undefined)?.todos;
      if (!Array.isArray(raw)) return null;
      return raw
        .map((item) => {
          const record = item as { readonly content?: unknown; readonly status?: unknown };
          return {
            content: typeof record.content === 'string' ? record.content : '',
            status: typeof record.status === 'string' ? record.status : 'pending',
          };
        })
        .filter((item) => item.content !== '');
    }
    return null;
  }
}
