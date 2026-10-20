/**
 * 模型结束原因的**归一化与截断判定**（2026-10-21）。
 *
 * 为什么必须有这一层：各厂商用不同字面量表达「输出被上限截断」——
 * OpenAI 兼容是 `length`，Anthropic 是 `stop_reason: 'max_tokens'`，
 * Responses 是 `incomplete + max_output_tokens`（适配器已转 `length`），
 * 部分兼容端点还会给 `max_output_tokens` / `max_tokens`。
 *
 * `StepRunner` 原先只认 `finishReason === 'length'`，导致 Anthropic 的
 * `max_tokens` 被当成正常完成：既不会续写，也不会丢弃半截工具调用。
 * 归一化必须发生在**适配器边界**（wire 值 → 统一值），恢复层只认统一值；
 * 同时保留 {@link ModelFinishReasons.isTruncated} 作为第三方适配器的防御性判据。
 */
export class ModelFinishReasons {
  /** 统一值：输出达到 token 上限。 */
  public static readonly LENGTH = 'length';

  /** 统一值：正常结束。 */
  public static readonly STOP = 'stop';

  /** 视为「输出被截断」的全部 wire 字面量（小写比较）。 */
  private static readonly TRUNCATED: ReadonlySet<string> = new Set([
    'length',
    'max_tokens',
    'max_output_tokens',
    'max-tokens',
    'max-output-tokens',
  ]);

  /**
   * 把厂商原始的结束原因归一化为统一值。
   *
   * - `max_tokens` / `max_output_tokens`（含连字符形态）⇒ `length`
   * - `stop` / `end_turn` / `completed` ⇒ `stop`
   * - 其余原样保留（`tool_calls`、`content_filter`、`refusal`…），
   *   由上层自行判断——**不臆造**未知语义。
   * @param raw 厂商 wire 层结束原因（可为空）。
   * @returns 归一化后的结束原因；输入为空时 undefined。
   */
  public static normalize(raw: string | null | undefined): string | undefined {
    if (raw === null || raw === undefined || raw === '') return undefined;
    const lower = raw.trim().toLowerCase();
    if (lower === '') return undefined;
    if (ModelFinishReasons.TRUNCATED.has(lower)) return ModelFinishReasons.LENGTH;
    if (lower === 'stop' || lower === 'end_turn' || lower === 'completed') {
      return ModelFinishReasons.STOP;
    }
    return raw;
  }

  /**
   * 结束原因是否表示「输出被截断」。
   *
   * 对**未归一化**的第三方适配器也成立：直接按 wire 字面量判断，
   * 避免把 Anthropic 风格值漏掉。
   * @param reason 结束原因（归一化前后均可）。
   * @returns 截断时为 true。
   */
  public static isTruncated(reason: string | undefined): boolean {
    if (reason === undefined) return false;
    return ModelFinishReasons.TRUNCATED.has(reason.trim().toLowerCase());
  }
}
