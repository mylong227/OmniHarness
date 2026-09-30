/** 回合完成闸门契约。 */
export interface CompletionGate {
  /** 闸门种类：决定「是否需要本回合改过文件」这一前置条件。 */
  readonly kind: 'status' | 'turn-end';
  /**
   * 核验本会话最近一次对源码改动的验证结果。
   * @param sessionId 会话 id。
   * @returns 失败摘要；验证通过、未验证或无法验证时为 undefined。
   */
  verify(sessionId: string): Promise<string | undefined>;
}
