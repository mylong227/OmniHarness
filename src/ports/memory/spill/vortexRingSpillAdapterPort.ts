import type { SpillPort } from './spillPort.js';

/**
 * @beta
 * 涡环包外溢适配器端口：在 `SpillPort` 之上新增冲刷健康检查能力（autoRun 用）。
 * 由 `adapters/spill/vortexRingSpillAdapter.ts` 的 `VortexRingSpillAdapter` 实现。
 */
export interface VortexRingSpillAdapterPort extends SpillPort {
  /**
   * 燧-4 冲刷（autoRun 用）：返回当前进程内持环数。环包元信息驻留内存，
   * 解环校验在 `read` 时 fail-closed 执行；此处仅做健康检查计数。
   * @returns 当前仍驻留进程内的环包数量。
   */
  flush(): { readonly activeRings: number };
}
