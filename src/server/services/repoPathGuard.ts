import { isAbsolute, relative, resolve } from 'node:path';

/**
 * 仓库内相对路径守卫（fail-closed）：拒绝空串、绝对路径、盘符路径与 `..` 穿越，
 * 返回相对工作区根的规范化路径。任何越界输入一律抛错，绝不静默放行。
 *
 * 与 `SsrfGuard` 同属安全判定族：把「什么算合法路径」这一条策略收敛到单点，
 * 供 git 审查（`DiffReview`）与行内评论（`DiffCommentStore`）复用，避免各处各写一份。
 * 工作区根以 getter 注入，兼容运行时 `workspace.switch`（每次判定重新求值）。
 */
export class RepoPathGuard {
  /**
   * @param workspaceRoot 当前工作区根的 getter（每次判定时重新求值）。
   */
  public constructor(private readonly workspaceRoot: () => string) {}

  /**
   * 校验并规范化仓库内相对路径。
   * @param raw 调用方原始路径，可能为绝对路径、Windows 盘符路径或含 `..` 穿越。
   * @returns 相对工作区根的规范化相对路径（如 `src/a.ts`）。
   * @throws 路径为空串、为绝对/盘符路径，或规范化后越出仓库范围时。
   */
  public resolve(raw: string): string {
    if (raw.length === 0) throw new Error('path 不能为空');
    if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('仅接受仓库内相对路径');
    const ws = this.workspaceRoot();
    const abs = resolve(ws, raw);
    const rel = relative(ws, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.length === 0) {
      throw new Error('路径越出仓库范围：' + raw);
    }
    return rel;
  }
}
