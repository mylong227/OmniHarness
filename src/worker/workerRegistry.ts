import type { Worker } from './worker.js';

/**
 * @beta
 * Worker 注册表：注册/选择外部 harness worker。
 */
export class WorkerRegistry {
  /** 已注册 worker 表：名称 → 实例（名称即选择键）。 */
  private readonly workers = new Map<string, Worker>();

  /**
   * 注册 worker；重名即抛错。
   * @param worker 待注册的 worker 实例（以其 name 为唯一键）
   * @returns 无返回值。
   * @throws 同名 worker 已存在时抛错，防静默覆盖
   */
  public register(worker: Worker): void {
    if (this.workers.has(worker.name)) {
      throw new Error(`worker 重复注册: ${worker.name}`);
    }
    this.workers.set(worker.name, worker);
  }

  /**
   * 选择 worker。
   * @param name worker 名称
   * @returns 对应的 worker 实例
   * @throws 名称未注册时抛错（fail-closed，不回退到默认 worker）
   */
  public get(name: string): Worker {
    const worker = this.workers.get(name);
    if (worker === undefined) {
      throw new Error(`未知 worker: ${name}`);
    }
    return worker;
  }

  /**
   * 已注册 worker 名。
   * @returns 全部已注册名称（按注册顺序排列）
   */
  public names(): string[] {
    return [...this.workers.keys()];
  }
}
