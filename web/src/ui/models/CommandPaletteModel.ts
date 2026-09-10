// 命令面板领域模型：搜索过滤与选中边界的纯逻辑。
// 零 React 依赖（可直接在 node 中单测），UI 组件只负责状态与渲染。

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  run: () => void;
}

/** 命令面板模型：持有命令集，提供过滤与索引移动能力。 */
export class CommandPaletteModel {
  constructor(private readonly commands: readonly CommandItem[]) {}

  /** 命令总数。 */
  get size(): number {
    return this.commands.length;
  }

  /**
   * 按查询词过滤：匹配 label / hint / group，大小写无关。
   * 空查询返回全部（返回新数组，避免外部改动内部命令集）。
   */
  filter(query: string): CommandItem[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [...this.commands];
    return this.commands.filter((c) =>
      (c.label + ' ' + (c.hint ?? '') + ' ' + (c.group ?? '')).toLowerCase().includes(q),
    );
  }

  /** 把索引夹到 [0, count-1]；空列表或越界一律回 0（fail-closed 到安全值）。 */
  clamp(index: number, count: number): number {
    if (count <= 0) return 0;
    if (index < 0) return 0;
    return Math.min(index, count - 1);
  }

  /** 按方向移动选中项：delta 为 +1 下移 / -1 上移。 */
  move(index: number, count: number, delta: number): number {
    return this.clamp(index + delta, count);
  }
}
