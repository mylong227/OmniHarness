/** 预热结果（可选能力，见 {@link EmbeddingPort.preload}）。 */
export interface EmbeddingPreloadOutcome {
  /** 是否成功就绪。 */
  readonly ok: boolean;
  /** 本次调用耗时（毫秒）。 */
  readonly ms: number;
  /** 是否由本次调用**真正构建**（false ⇒ 命中既有实例，本来就是热的）。 */
  readonly built: boolean;
  /** 失败原因（`ok=false` 时）。 */
  readonly error?: string;
}
