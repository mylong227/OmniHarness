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
  /** 各路径首次写入前的内容快照（null = 新建文件），diff 的 before 侧。 */
  private readonly baseline = new Map<string, string | null>();
  /** 各路径最新一次精确写入后的内容，diff 的 after 侧。 */
  private readonly current = new Map<string, string>();
  /** 追踪有效性：出现不可精确追踪的变更时永久失效（直到 reset）。 */
  private valid = true;

  /**
   * 是否仍可产出可信 diff。
   * @returns 未发生不可追踪变更时为 true；invalidate 后恒为 false。
   */
  public get isValid(): boolean {
    return this.valid;
  }

  /**
   * 本回合变更文件数。
   * @returns current 表中的路径数（含新建与改写）。
   */
  public get changedCount(): number {
    return this.current.size;
  }

  /**
   * 记录一次精确写入（before 为 null 表示新建文件；同文件多次写只保留首次 baseline）。
   * @param path 被写入的文件路径。
   * @param before 写入前内容快照；新建文件为 null。
   * @param after 写入后的完整内容。
   */
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

  /**
   * 变更文件路径（字典序，保证渲染顺序稳定）。
   * @returns 排序后的变更路径数组。
   */
  public changedPaths(): readonly string[] {
    return [...this.current.keys()].sort();
  }

  /**
   * 产出整回合 unified diff；无实质差异或已失效时返回 undefined。
   * @returns 各文件 diff 按字典序拼接的 unified diff；失效或无实质差异时为 undefined。
   */
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
