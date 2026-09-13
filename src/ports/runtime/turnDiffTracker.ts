/**
 * 回合级变更追踪端口（P1 解耦）。
 *
 * 原 `TurnDiffTracker`（core 类）被适配器 `adapters/diff/turnDiffHooks` 以 `import type`
 * 引用，构成 adapters→core 违规（门禁按导入路径计边）。抽到端口后适配器仅依赖此接口类型，
 * 实例由组合根注入；core 实现类 `implements` 本接口。
 */

/** 回合级变更追踪端口：累积可精确追踪的文件写入，回合结束产出 unified diff。 */
export interface TurnDiffTrackerPort {
  /** 记录一次精确写入（before 为 null 表示新建文件；同文件多次写只保留首次 baseline）。 */
  noteWrite(path: string, before: string | null, after: string): void;
  /** 标记本回合出现不可精确追踪的变更：清空并永久失效，直到 `reset()`。 */
  invalidate(): void;
}
