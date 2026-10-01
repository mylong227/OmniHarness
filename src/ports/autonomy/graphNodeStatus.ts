/** 单节点实时状态（供 Web 编排视图与 graph.progress 通知）。 */
export type GraphNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
