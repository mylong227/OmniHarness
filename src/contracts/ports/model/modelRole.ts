/**
 * 模型角色（2026-10-22，P1-4 第一片）。
 *
 * 同一会话里不同工作负载对模型的要求不同：执行要稳、审查要独立、压缩要便宜、规划要强。
 * 角色只是**路由提示**：`by-role` 策略按 `modelRouter.roles` 把角色映射到 entry；
 * 未配置时所有角色回退到第一个 entry（行为与旧版一致）。
 */
export type ModelRole =
  'executor' | 'planner' | 'reviewer' | 'compactor' | 'memory' | 'guardian' | 'goal' | 'subagent';
