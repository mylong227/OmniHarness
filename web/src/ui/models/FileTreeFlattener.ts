// 文件树扁平化：递归收集树中的文件路径（@mention 补全的数据源）。

import type { FsNode } from '../../types/models.js';

/** 文件树扁平化器。 */
export class FileTreeFlattener {
  /** 深度优先收集所有 type==='file' 节点的 path；目录不入结果。 */
  public static collect(nodes: readonly FsNode[]): string[] {
    const out: string[] = [];
    FileTreeFlattener.walk(nodes, out);
    return out;
  }

  private static walk(nodes: readonly FsNode[], out: string[]): void {
    for (const n of nodes) {
      if (n.type === 'file') out.push(n.path);
      if (n.children !== undefined) FileTreeFlattener.walk(n.children, out);
    }
  }
}
