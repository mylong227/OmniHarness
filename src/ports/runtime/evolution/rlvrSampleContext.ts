/**
 * @beta
 * RLVR 采样上下文（S5 分桶口径的工况来源）：把「这个 prompt 属于哪个工况」从候选透传到采样产物。
 *
 * 2026-10-11 从 `src/evolution/rlvrLoop.ts` 外迁至端口层（同 `codeCandidate.ts` 的理由）。
 */
export interface RlvrSampleContext {
  /** 候选来源算子（如 `twist:a+b`）；分桶键取其前缀。 */
  readonly source?: string | undefined;
  /**
   * **历史失败原因**（E3+ 回填）：会被拼进采样 prompt 的失败原因段，供模型"别重犯"。
   *
   * 数据来源是既有 replay buffer / 失败模式挖掘器（`FailurePatternMiner` 的提案摘要），
   * 不需要新通道；为空或缺省 ⇒ prompt **原文透传**（不出现空标题段）。
   */
  readonly failureReasons?: readonly string[] | undefined;
}
