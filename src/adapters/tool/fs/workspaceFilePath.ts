/**
 * 工作区路径键与差异显示（从 `WorkspaceFileCoordinator` 拆出的**纯函数**工具）。
 *
 * 为什么单独成类：协调器已达到「上帝类」阈值；而路径归一化/排序/哈希是独立的、
 * 可单测的纯逻辑，混在锁与租约里既难读也会把文件推过体量上限。
 */
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

/** 工作区路径工具。 */
export class WorkspaceFilePath {
  /**
   * 规范化路径键：Windows 大小写不敏感文件系统上同一文件可能有两种写法。
   * @param path 绝对或相对路径。
   * @returns 归一化绝对键（Windows 小写）。
   */
  public static keyOf(path: string): string {
    const absolute = resolve(path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }

  /**
   * 去重并按锁键排序（固定顺序 = 不会形成等待环）。
   * @param paths 绝对路径列表。
   * @returns 排序后的唯一路径。
   */
  public static uniqueSorted(paths: readonly string[]): string[] {
    const byKey = new Map<string, string>();
    for (const path of paths) {
      const absolute = resolve(path);
      byKey.set(WorkspaceFilePath.keyOf(absolute), absolute);
    }
    return [...byKey.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, path]) => path);
  }

  /**
   * 锁目录哈希（同一路径在所有进程中得到同一锁名）。
   * @param key 归一化路径。
   * @returns sha256 十六进制串。
   */
  public static hashOf(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex');
  }

  /**
   * 生成面向用户的相对路径。
   * @param root 工作区根。
   * @param absolutePath 绝对路径。
   * @returns 相对工作区路径；跨根时退回绝对路径。
   */
  public static displayOf(root: string, absolutePath: string): string {
    const rel = relative(root, absolutePath);
    return rel === '' || rel.startsWith('..') ? absolutePath : rel;
  }
}
