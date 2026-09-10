import type { Worker, WorkerRequest, WorkerResult } from './worker.js';

/**
 * @beta
 * 演示 worker：固定输出（测试/离线演示用，可模拟任意 harness）。
 */
export class SimpleWorker implements Worker {
  public constructor(
    private readonly workerName: string,
    private readonly outputText?: string,
  ) {}

  /** 子代理名称。 */
  public get name(): string {
    return this.workerName;
  }

  /** 运行任务。 */
  public async run(request: WorkerRequest): Promise<WorkerResult> {
    const startedAt = Date.now();
    const output = this.outputText ?? `[${this.workerName}] 收到任务: ${request.task}`;
    return { ok: true, output, durationMs: Date.now() - startedAt };
  }
}
