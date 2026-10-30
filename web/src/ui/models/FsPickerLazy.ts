// 选择器的「双源」key 空间（2026-10-30 重设计 P2，docs/PICKER_REDESIGN_2026-10-30.md §10）。
//
// 同一棵树里有两类节点：
//   · 工作区节点：key 就是 `fs.list` 给的路径（相对/绝对由后端决定）；
//   · 文件系统懒加载节点：key 以 `fs:` 前缀标记，去掉前缀才是真实绝对路径。
//
// 为什么要前缀而不是只看「加载来源」：勾选集与展开集都是 key 的集合，路径相同的节点
// （工作区根正好是盘符根时）必须能区分「工作区视图」与「文件系统视图」，否则勾选会串。
// 这个模块是唯一事实源——两个选择器都从这里取，别各写一份前缀字面量。

/** 懒加载子树根的 key。 */
export const FS_ROOT = 'fs:';

/**
 * 真实路径 → 懒加载节点 key。
 * @param path 绝对路径
 * @returns 带前缀的 key
 */
export function fsKeyOf(path: string): string {
  return FS_ROOT + path;
}

/**
 * 懒加载节点 key → 真实路径；非懒加载 key 或根节点返回 null。
 * @param key 树节点 key
 * @returns 绝对路径 / null
 */
export function fsPathOf(key: string): string | null {
  if (!key.startsWith(FS_ROOT)) return null;
  const path = key.slice(FS_ROOT.length);
  // 根节点 `fs:` 本身没有路径（它表示「列盘符」这一层，调用方要传 undefined）。
  return path === '' ? null : path;
}

/**
 * 该节点是否属于懒加载子树。
 * @param key 树节点 key
 * @returns 是则 true
 */
export function isFsKey(key: string): boolean {
  return key.startsWith(FS_ROOT);
}
