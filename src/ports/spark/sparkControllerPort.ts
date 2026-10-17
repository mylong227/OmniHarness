import type { SparkCycleReport } from './sparkCycleReport.ts';

/**
 * @beta
 * 火花控制器端口：组合根契约（`ports/composition/omniHarnessRuntime.ts`）与配置面
 * （`ports/config/resolvedConfig.ts`）只需持有并驱动它，不需要实现类。
 *
 * 2026-10-11：原先两处字段直接用实现类 `SparkController`（`ports→实现层` 禁边）。本接口列的是
 * 该类的公开面（`src/spark/sparkController.ts`：`readonly autoRun` + `cycle()`），
 * 实现类结构性满足它，注入处零改动。
 */
export interface SparkControllerPort {
  /** 是否开启自动运行（由配置决定，只读）。 */
  readonly autoRun: boolean;

  /**
   * 跑一轮火花（内部按 `autoRun` 决定是否真触发）。
   *
   * @returns 本轮报告（判据与遥测据此核对）。
   */
  cycle(): Promise<SparkCycleReport>;
}
