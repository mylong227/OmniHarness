import { PathTraversalError } from './pathTraversalError.js';
import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';

/** 路径越界 / 符号链接逃逸错误。 */

/**
 * 工作区路径守卫：阻止路径越界访问工作区之外。
 * 判定分两层：
 *  1. 词法越界（最快、零 IO、不依赖真实文件系统）；
 *  2. 真实路径越界——当工作区根真实存在时，经 realpath 展开符号链接 / junction，
 *     拦截「词法在内、真实指向在外」的逃逸（如工作区内软链指向 /etc）。
 */
export class WorkspaceGuard {
  private readonly base: string;

  public constructor(workspaceRoot: string) {
    this.base = resolve(workspaceRoot);
  }

  /** 相对路径是否落在工作区内（词法 + 真实路径双重判定，拦截 symlink 逃逸）。 */
  public isInside(relativePath: string): boolean {
    try {
      this.resolveSafe(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析相对路径为安全绝对路径；一旦越界或经符号链接逃逸出工作区即抛错。
   * 调用方可直接拿返回值做实际 IO，复用同一道校验。
   */
  public resolveSafe(relativePath: string): string {
    const lexical = resolve(this.base, relativePath);
    // 1) 词法越界直接拒（最快、零 IO）。
    if (lexical !== this.base && !lexical.startsWith(this.base + sep)) {
      throw new PathTraversalError(`路径词法越界: ${relativePath}`);
    }
    // 2) 真实路径校验：仅当工作区根真实存在时才做——symlink 逃逸需要真实 fs 才能解析。
    //    根不存在（测试夹具 / 尚未初始化）时无真实逃逸面，退回词法判定已足够。
    //    注意：不能用 `realBase === this.base` 判断是否跳过——根本身就是规范化真实路径时，
    //    realpath 会返回与之相等的字符串，必须改用 existsSync 区分「根不存在」。
    const realBase = this.rp(this.base);
    if (realBase === this.base && !existsSync(this.base)) {
      return lexical;
    }
    const realChild = this.realpathExisting(lexical);
    if (realChild !== realBase && !realChild.startsWith(realBase + sep)) {
      throw new PathTraversalError(`路径经符号链接逃逸出工作区: ${relativePath}`);
    }
    return lexical;
  }

  /** realpath（libuv 版会展开 symlink / Windows junction）；失败（路径不存在 / 无权限）回退原路径。 */
  private rp(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }

  /** 解析已存在路径的 realpath；路径不存在则沿父目录上溯至首个真实存在的祖先。 */
  private realpathExisting(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      const parent = dirname(p);
      if (parent === p) return p;
      return this.realpathExisting(parent);
    }
  }
}
export { PathTraversalError };
