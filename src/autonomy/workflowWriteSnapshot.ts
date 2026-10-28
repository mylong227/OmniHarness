import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** 单文件快照。 */
interface FileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly content?: string | undefined;
}

/**
 * 工作流步骤的**声明写集**快照/回滚（2026-10-29，A5 回滚）。
 *
 * 只处理 `WorkflowStep.writes` 显式声明的**文件**（目录/通配符跳过并留痕），
 * 不做 worktree 级隔离——那是另一层结构改造。回滚是「尽力而为」：
 * 失败会记录 warn，但绝不掩盖原始步骤错误。
 */
export class WorkflowWriteSnapshot {
  /** 捕获时的文件快照。 */
  private readonly entries: readonly FileSnapshot[];

  private constructor(entries: readonly FileSnapshot[]) {
    this.entries = entries;
  }

  /**
   * 捕获声明写集。
   * @param workspaceRoot 工作区根（绝对路径）。
   * @param paths 步骤声明的相对路径。
   * @returns 快照；无有效路径时返回空快照。
   */
  public static capture(workspaceRoot: string, paths: readonly string[]): WorkflowWriteSnapshot {
    const root = resolve(workspaceRoot);
    const entries: FileSnapshot[] = [];
    for (const relative of paths) {
      let absolute: string;
      try {
        absolute = resolve(root, relative);
      } catch {
        continue;
      }
      // 防越界：声明路径不得解析到工作区外。
      if (absolute !== root && !absolute.startsWith(root + sep)) continue;
      try {
        if (!existsSync(absolute)) {
          entries.push({ path: absolute, existed: false });
          continue;
        }
        if (statSync(absolute).isDirectory()) continue;
        entries.push({ path: absolute, existed: true, content: readFileSync(absolute, 'utf8') });
      } catch {
        // 读不到就不纳入快照（不制造“回滚到半截”的假象）。
      }
    }
    return new WorkflowWriteSnapshot(entries);
  }

  /**
   * 回滚到快照（存在则恢复内容，原本不存在则删除）。
   * @returns 实际恢复/删除的文件数。
   */
  public restore(): number {
    let changed = 0;
    for (const entry of this.entries) {
      try {
        if (entry.existed && entry.content !== undefined) {
          mkdirSync(dirname(entry.path), { recursive: true });
          writeFileSync(entry.path, entry.content, 'utf8');
        } else if (!entry.existed && existsSync(entry.path)) {
          rmSync(entry.path, { force: true });
        }
        changed += 1;
      } catch {
        // 单文件回滚失败不阻断其它文件；调用方以 warn 记录。
      }
    }
    return changed;
  }

  /** 快照条目数（观测/测试）。 */
  public get size(): number {
    return this.entries.length;
  }
}
