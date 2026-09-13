import type { Worker, WorkerRequest, WorkerResult } from './worker.js';

/**
 * @beta
 * 演示 worker：固定输出（测试/离线演示用，可模拟任意 harness）。
 */
export class SimpleWorker implements Worker {
  /**
   * @param workerName 子代理名称（输出中的身份标识）
   * @param outputText 固定输出文本（缺省时回显收到的任务文本）
   */
  public constructor(
    private readonly workerName: string,
    private readonly outputText?: string,
  ) {}

  /** 子代理名称。 */
  public get name(): string {
    return this.workerName;
  }

  /**
   * 运行任务。
   * @param request 任务描述（仅使用 task 文本）
   * @returns 恒成功的执行结果：固定输出文本或任务回显，附耗时
   */
  public async run(request: WorkerRequest): Promise<WorkerResult> {
    const startedAt = Date.now();
    const output = this.outputText ?? `[${this.workerName}] 收到任务: ${request.task}`;
    return { ok: true, output, durationMs: Date.now() - startedAt };
  }
}
