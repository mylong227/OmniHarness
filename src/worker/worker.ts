/**
 * @beta
 * 子代理任务。
 */
export interface WorkerRequest {
  readonly task: string;
  readonly workspaceRoot: string;
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
