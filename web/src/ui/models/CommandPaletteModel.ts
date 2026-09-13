// 命令面板领域模型：搜索过滤与选中边界的纯逻辑。
// 零 React 依赖（可直接在 node 中单测），UI 组件只负责状态与渲染。

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  run: () => void;
}

/** 分组内的命令条目：`index` 为该项在扁平过滤结果中的下标（供键盘高亮与执行定位）。 */
export interface GroupedCommandEntry {
  /** 命令项。 */
  item: CommandItem;
  /** 在 `filter(query)` 扁平结果中的下标。 */
  index: number;
}

/** 一个命令分组（渲染用；不改变键盘选中的扁平语义）。 */
export interface CommandGroup {
  /** 分组名（未标 group 的命令归入默认分组）。 */
  group: string;
  /** 组内命令（保持原顺序）。 */
  items: GroupedCommandEntry[];
}

/** 未标注 group 的命令的兜底分组名。 */
const DEFAULT_GROUP = '其他';

/** 命令面板模型：持有命令集，提供过滤与索引移动能力。 */
export class CommandPaletteModel {
  public constructor(private readonly commands: readonly CommandItem[]) {}

  /** 命令总数。 */
  public get size(): number {
    return this.commands.length;
  }

  /**
   * 按查询词过滤：匹配 label / hint / group，大小写无关。
   * 空查询返回全部（返回新数组，避免外部改动内部命令集）。
   */
  public filter(query: string): CommandItem[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [...this.commands];
    return this.commands.filter((c) =>
      (c.label + ' ' + (c.hint ?? '') + ' ' + (c.group ?? '')).toLowerCase().includes(q),
    );
  }

  /** 把索引夹到 [0, count-1]；空列表或越界一律回 0（fail-closed 到安全值）。 */
  public clamp(index: number, count: number): number {
    if (count <= 0) return 0;
    if (index < 0) return 0;
    return Math.min(index, count - 1);
  }

  /** 按方向移动选中项：delta 为 +1 下移 / -1 上移。 */
  public move(index: number, count: number, delta: number): number {
    return this.clamp(index + delta, count);
  }

  /**
   * 按 `group` 分组（保持分组首次出现顺序，组内保持原顺序）。
   *
   * 关键不变量：条目上的 `index` **始终等于 `filter(query)` 的扁平下标**——
   * 键盘上下移动与执行都按扁平索引工作，分组只影响渲染、不改变选中语义。
   * @param query 查询词（语义同 `filter`）
   * @returns 分组列表；无匹配时为空数组
   */
  public grouped(query: string): CommandGroup[] {
    const groups: CommandGroup[] = [];
    const byName = new Map<string, CommandGroup>();
    this.filter(query).forEach((item, index) => {
      const group = item.group && item.group.length > 0 ? item.group : DEFAULT_GROUP;
      let bucket = byName.get(group);
      if (!bucket) {
        bucket = { group, items: [] };
        byName.set(group, bucket);
        groups.push(bucket);
      }
      bucket.items.push({ item, index });
    });
    return groups;
  }
}
