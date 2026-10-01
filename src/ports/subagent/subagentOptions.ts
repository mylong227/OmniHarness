/**
 * @beta
 * 子智能体编排参数。
 *
 * 已从 `subagent/subagentTypes.ts` 外迁到 ports/subagent：原文件退化为纯再导出桶，调用点零改动。
 */
export interface SubagentOptions {
  readonly maxDepth?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  /** 单个子智能体的步数上限。 */
  readonly maxSteps?: number | undefined;
}
