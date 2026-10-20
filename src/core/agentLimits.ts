/**
 * Agent 的运维级输出上限解析（`OMNI_MAX_OUTPUT_TOKENS`）。
 *
 * 单独成类是为了让 `Agent` 不继续膨胀（上帝类门禁）；该旋钮属**运维/成本**，
 * 不进入用户配置 schema 与 fail-closed 校验面（与 `OMNI_LOOP_SOFT_MS` 同先例）。
 */
export class AgentLimits {
  /**
   * 解析单次响应输出上限。
   * @returns 正整数 token 上限；未配置/非法/<=0 时为 undefined。
   */
  public static maxOutputTokens(): number | undefined {
    const raw = process.env.OMNI_MAX_OUTPUT_TOKENS;
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
}
