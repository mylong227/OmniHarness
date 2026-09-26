/**
 * @beta
 * 子代理任务。
 */
export interface WorkerRequest {
  readonly task: string;
  readonly workspaceRoot: string;
  /**
   * 会话取消信号（可选）：给出时 worker 应把取消下传子进程并尽快收尾。
   *
   * 存在理由（2026-09-26 审计 X3/F3）：原先 `WorkerRequest` 连 signal 字段都没有，而 `delegate`
   * 在工具调度器里是**串行屏障** —— 一个挂死的 worker 会永久阻塞整个回合，且 abort 后子进程成孤儿。
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * @beta
 * 子代理结果。
 */
export interface WorkerResult {
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
}

/**
 * @beta
 * 外部 harness worker 统一插口（codex / claude-code / dsh / opencode）。
 */
export interface Worker {
  readonly name: string;
  run(request: WorkerRequest): Promise<WorkerResult>;
}
