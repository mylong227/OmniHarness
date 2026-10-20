/**
 * 独立审查端口（VER-01，2026-10-20）。
 *
 * 关键约束：reviewer 只接收 **diff + 任务目标 + 测试结果**，不接收父会话历史。
 * 这不是“再问模型一遍”，而是换一个干净上下文、换一个目标（找缺陷）的独立检查。
 */

/** 审查严重度。 */
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/** 一条审查发现。 */
export interface ReviewFinding {
  readonly severity: ReviewSeverity;
  /** 文件路径（diff 内的路径）。 */
  readonly file: string;
  /** 行号（可选）。 */
  readonly line?: number | undefined;
  /** 问题描述。 */
  readonly issue: string;
  /** 证据（触发条件/代码片段/测试输出）。 */
  readonly evidence: string;
  /** 建议（可选）。 */
  readonly suggestion?: string | undefined;
}

/** 审查输入。 */
export interface ReviewRequest {
  /** 本回合 diff（unified diff 或文件变更摘要）。 */
  readonly diff: string;
  /** 任务目标。 */
  readonly goal: string;
  /** 相关测试结果（可选）。 */
  readonly tests?: string | undefined;
}

/** 审查结果。 */
export interface ReviewReport {
  /** 是否成功完成审查（模型/解析失败为 false）。 */
  readonly ok: boolean;
  /** 结构化发现（解析失败时为空）。 */
  readonly findings: readonly ReviewFinding[];
  /** 原始模型输出（审计/调试用）。 */
  readonly raw: string;
}

/** 独立审查端口。 */
export interface ReviewPort {
  review(request: ReviewRequest): Promise<ReviewReport>;
}
