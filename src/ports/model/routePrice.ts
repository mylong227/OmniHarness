/** 路由定价：某模型每百万 token 的输入 / 输出单价（USD，#S29）。 */
export interface RoutePrice {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  /**
   * 命中提示缓存的输入单价（USD / 百万 token，可选，P5）。
   *
   * 各家对「缓存读取」单独计价（通常远低于未命中输入价）。缺省表示**未提供缓存价**
   * ——此时缓存命中的 token 仍按 `inputPer1M` 计，即**不打折**。这是刻意的保守取向：
   * 宁可多记成本（更早熔断），也不凭猜测给折扣而漏记花费。
   */
  readonly cachedInputPer1M?: number | undefined;
}
