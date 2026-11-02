/** 路由策略（`ucb1` = 自适应多臂老虎机：按成功/延迟学习）。 */
export type RouterStrategy =
  'least-cost' | 'round-robin' | 'by-task' | 'by-context' | 'by-role' | 'health-fallback' | 'ucb1';
