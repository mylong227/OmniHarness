import type { DecisionRequest } from './decisionRequest.js';
import type { DecisionResponse } from './decisionResponse.js';

/**
 * 决策引擎端口：System-1 类型化判断（替代 LLM 长推理做高频结构化决策）。
 */
export interface DecisionEngine {
  /** 端口名（如 `laya`）。 */
  readonly name: string;

  /**
   * 引擎当前是否可用（权重 / 后端就绪）。实现可缓存探测结果。
   *
   * @returns 可用时为 true。
   */
  isAvailable(): boolean | Promise<boolean>;

  /**
   * 单次前向类型化决策。
   *
   * 失败 / 超时 / 后端不可用均**不得抛错**——返回 `{ available:false }`（fail-open）。
   *
   * @param request 决策请求（state + 问题集）。
   * @returns 决策响应；不可用时 `available:false`、answers 为空。
   */
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}
