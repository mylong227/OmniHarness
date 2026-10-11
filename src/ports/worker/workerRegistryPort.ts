import type { Worker } from './worker.js';

/**
 * @beta
 * worker 注册表端口：配置面（`ports/config/omniHarnessConfig.ts`）只需"能登记/取用/点名 worker"，
 * 不需要实现类。
 *
 * 2026-10-11：原先配置面字段直接用实现类 `WorkerRegistry`（`ports→实现层` 禁边）。本接口列的是
 * 该类的公开面（`src/worker/workerRegistry.ts`：`register` / `get` / `names`），
 * 实现类结构性满足它，注入处零改动。
 */
export interface WorkerRegistryPort {
  /**
   * 登记 worker（重名即抛错）。
   *
   * @param worker worker 实例。
   * @returns 无返回值。
   */
  register(worker: Worker): void;

  /**
   * 按名取 worker。
   *
   * @param name worker 名。
   * @returns worker 实例（未登记即抛错——fail-closed，避免静默派发到不存在的 harness）。
   */
  get(name: string): Worker;

  /**
   * 已登记的 worker 名（按登记顺序）。
   *
   * @returns 名字数组。
   */
  names(): string[];
}
