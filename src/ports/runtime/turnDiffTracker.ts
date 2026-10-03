/**
 * 回合级变更追踪端口（P1 解耦）。
 *
 * 原 `TurnDiffTracker`（core 类）被适配器 `adapters/diff/turnDiffHooks` 以 `import type`
 * 引用，构成 adapters→core 违规（门禁按导入路径计边）。抽到端口后适配器仅依赖此接口类型，
 * 实例由组合根注入；core 实现类 `implements` 本接口。
 */

/** 回合级变更追踪端口：累积可精确追踪的文件写入，回合结束产出 unified diff。 */
export interface TurnDiffTrackerPort {
  /**
   * 本回合是否已登记该路径的写入前基线。
   *
   * 供工具钩子避免同回合对同一文件重复读盘；**基线本身由本端口持有**（唯一事实源），
   * 钩子不得自建第二份基线表——两份基线表若生命周期不同步，就会出现「回合 2 的 before
   * 是回合 1 之前的内容」这类跨回合错误（2026-10-03 清偿的 PROJECT_BOARD §3-2 缺陷）。
   * @param path 文件路径。
   * @returns 已登记（含「文件不存在」记 null 的情形）时为 true。
   */
  hasBaseline(path: string): boolean;
  /**
   * 登记写入前基线（工具执行**前**调用；同回合同路径只记首次）。
   * @param path 文件路径。
   * @param before 写入前内容；文件不存在为 null。
   */
  recordBaseline(path: string, before: string | null): void;
  /**
   * 登记写入后内容（工具执行**后**调用），baseline 侧取 {@link TurnDiffTrackerPort.recordBaseline}
   * 登记的值。
   * @param path 文件路径。
   * @param after 写入后的完整内容；未登记基线的路径按**新建文件**处理（与「缺失即空串」的历史口径一致）。
   */
  noteWrite(path: string, after: string): void;
  /** 标记本回合出现不可精确追踪的变更：清空并永久失效，直到 `reset()`。 */
  invalidate(): void;
  /** 本回合变更文件数（含新建与改写）。 */
  readonly changedCount: number;
  /** 产出整回合 unified diff；无实质差异或已失效时返回 undefined。 */
  getUnifiedDiff(): string | undefined;
  /** 重置（新回合开始）：恢复有效并清空基线/当前快照。 */
  reset(): void;
}
