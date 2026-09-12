import { renderUnifiedDiff } from '../util/unifiedDiff.js';
import type { TurnDiffTrackerPort } from '../ports/turnDiffTracker.js';

/**
 * 回合级变更追踪（对标 codex `turn_diff_tracker.rs`）。
 *
 * 内存累积本回合内**可精确追踪**的文件写入（write_file / apply_patch），回合结束产出 unified diff。
 * 关键约束：一旦出现无法精确追踪的变更（例如 shell 直接改文件），立刻 `invalidate()` 且本回合
 * **不再产出 diff**——宁可不给，也不给一份不完整、会误导人的差异。
 */
export class TurnDiffTracker implements TurnDiffTrackerPort {
  private readonly baseline = new Map<string, string | null>();
  private readonly current = new Map<string, string>();
  private valid = true;

  /** 是否仍可产出可信 diff。 */
  public get isValid(): boolean {
    return this.valid;
  }

  /** 本回合变更文件数。 */
  public get changedCount(): number {
    return this.current.size;
  }

  /** 记录一次精确写入（before 为 null 表示新建文件；同文件多次写只保留首次 baseline）。 */
  public noteWrite(path: string, before: string | null, after: string): void {
    if (!this.valid || !this.baseline.has(path)) {
      this.baseline.set(path, before);
    }
    this.current.set(path, after);
  }

  /** 标记本回合出现不可精确追踪的变更：清空并永久失效，直到 `reset()`。 */
  public invalidate(): void {
    this.valid = false;
    this.baseline.clear();
    this.current.clear();
  }

  /** 重置（新回合开始）。 */
  public reset(): void {
    this.valid = true;
    this.baseline.clear();
    this.current.clear();
  }

  /** 变更文件路径（字典序，保证渲染顺序稳定）。 */
  public changedPaths(): readonly string[] {
    return [...this.current.keys()].sort();
  }

  /** 产出整回合 unified diff；无实质差异或已失效时返回 undefined。 */
  public getUnifiedDiff(): string | undefined {
    if (!this.valid || this.current.size === 0) {
      return undefined;
    }
    const parts = this.changedPaths()
      .map((path) =>
        renderUnifiedDiff(path, this.baseline.get(path) ?? '', this.current.get(path) ?? ''),
      )
      .filter((diff) => diff !== '');
    return parts.length === 0 ? undefined : parts.join('\n');
  }
}
