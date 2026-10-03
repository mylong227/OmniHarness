import { UnifiedDiff } from '../util/unifiedDiff.js';
import type { TurnDiffTrackerPort } from '../ports/runtime/turnDiffTracker.js';

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
   * 本回合是否已登记该路径的写入前基线。
   * @param path 文件路径。
   * @returns 已登记（含记为 null 的「文件不存在」）时为 true。
   */
  public hasBaseline(path: string): boolean {
    return this.baseline.has(path);
  }

  /**
   * 登记写入前基线（工具执行前调用；同回合同路径只记首次）。
   *
   * 基线由本类**唯一持有**：工具钩子只负责「读一次盘」，不再自建第二份基线表——两份表若
   * 生命周期不同步（旧实现里钩子的表在 `reset()` 时不清理），回合 2 的 diff before 侧会是
   * 回合 1 之前的内容，`turn_diff` 事件呈现跨回合累计差异（PROJECT_BOARD §3-2）。
   * @param path 被写入的文件路径。
   * @param before 写入前内容快照；新建文件为 null。
   * @returns 无返回值。
   */
  public recordBaseline(path: string, before: string | null): void {
    // 失效后拒绝写入（2026-10-03 修）：`invalidate()` 的语义是「清空并永久失效」，失效后的
    // 记账注定进不了 diff（`getUnifiedDiff` 因 `!valid` 返回 undefined），却会把 `changedCount`
    // 从 0 抬成非 0——turn-end 完成闸门据此误判「本回合改过文件」而平白跑一次验证。
    if (!this.valid) {
      return;
    }
    if (!this.baseline.has(path)) {
      this.baseline.set(path, before);
    }
  }

  /**
   * 记录一次精确写入（baseline 侧取 {@link TurnDiffTracker.recordBaseline} 登记的值）。
   * @param path 被写入的文件路径。
   * @param after 写入后的完整内容。
   * @returns 无返回值。
   */
  public noteWrite(path: string, after: string): void {
    // 失效后拒绝写入（理由同上）。
    if (!this.valid) {
      return;
    }
    // 未登记基线 ⇒ 按新建文件处理：与历史口径一致（旧实现 `baseline.get(path) ?? ''` 把
    // 缺失基线当空串，即「此前不存在」）。已登记则**保持首次值**，同回合多次写只暴露净差异。
    if (!this.baseline.has(path)) {
      this.baseline.set(path, null);
    }
    this.current.set(path, after);
  }

  /** 标记本回合出现不可精确追踪的变更：清空并永久失效，直到 `reset()`。
   * @returns 无返回值。
   */
  public invalidate(): void {
    this.valid = false;
    this.baseline.clear();
    this.current.clear();
  }

  /** 重置（新回合开始）。
   * @returns 无返回值。
   */
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
        UnifiedDiff.renderUnifiedDiff(
          path,
          this.baseline.get(path) ?? '',
          this.current.get(path) ?? '',
        ),
      )
      .filter((diff) => diff !== '');
    return parts.length === 0 ? undefined : parts.join('\n');
  }
}
