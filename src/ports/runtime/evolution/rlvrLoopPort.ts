import type { RlvrRoundResult } from './rlvrRoundResult.ts';
import type { RlvrSampleContext } from './rlvrSampleContext.ts';

/**
 * @beta
 * RLVR 主循环端口：`ports/runtime/evolution/evolutionControllerOptions.ts` 的配置面只需
 * "能跑一轮"这一件事，故端口只声明 {@link RlvrLoopPort.run}。
 *
 * 2026-10-11：原先该配置面用内联 `import(...)` **类型查询**直接引用实现类（`architectureGate` 的
 * `ports→实现层` 禁边）。实现类 `src/evolution/rlvrLoop.ts` 结构性满足本接口，无需 `implements`
 * （TS 结构化类型），组合根注入处零改动。
 */
export interface RlvrLoopPort {
  /**
   * 跑一轮 sample-filter-replay。
   *
   * @param prompt 任务 prompt。
   * @param context 采样上下文（工况来源与历史失败原因；缺省 = 原文透传）。
   * @returns 单轮结果（保留数 / 最佳候选 / 缓冲大小）。
   */
  run(prompt: string, context?: RlvrSampleContext): Promise<RlvrRoundResult>;
}
