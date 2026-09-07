import type { Worker } from './worker.js';

/**
 * @beta
 * Worker 注册表：注册/选择外部 harness worker。
 */
export class WorkerRegistry {
  private readonly workers = new Map<string, Worker>();

  /** 注册 worker；重名即抛错。 */
  register(worker: Worker): void {
    if (this.workers.has(worker.name)) {
      throw new Error(`worker 重复注册: ${worker.name}`);
    }
    this.workers.set(worker.name, worker);
  }

  /** 选择 worker。 */
  get(name: string): Worker {
    const worker = this.workers.get(name);
    if (worker === undefined) {
      throw new Error(`未知 worker: ${name}`);
    }
    return worker;
  }

  /** 已注册 worker 名。 */
  names(): string[] {
    return [...this.workers.keys()];
  }
}
