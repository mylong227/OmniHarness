import type { ModelPort } from './model.js';

/** 路由条目：一个底层模型适配器 + 其标识与定价。 */
export interface RouterEntry {
  /** 底层模型适配器（真正执行 generate/stream 的对象）。 */
  readonly adapter: ModelPort;
  /** 该 entry 的模型标识（记账与日志按键）。 */
  readonly model: string;
  /** 每 1k token 的输入/输出单价（USD）；缺省时 least-cost 策略无法对该模型计价。 */
  readonly pricing?: { readonly inputPer1k: number; readonly outputPer1k: number } | undefined;
}
