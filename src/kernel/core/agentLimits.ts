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

  /**
   * 回合 token 硬预算：config 优先，env 兜底；非法/未设 ⇒ 0（关闭）。
   * @param configured `config.turnTokenBudget`。
   * @returns 正整数上限；0 = 未启用。
   */
  public static tokenBudget(configured: number | undefined): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    const fromEnv = Number(process.env.OMNI_TURN_TOKEN_BUDGET);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 0;
  }

  /**
   * 回合 token 软预算：硬预算 >0 时取 80%；否则 env，再否则 5,000,000。
   * @param configured `config.turnTokenBudget`。
   * @returns 软预算（0 = 关闭）。
   */
  public static softTokenBudget(configured: number | undefined): number {
    const hard = AgentLimits.tokenBudget(configured);
    if (hard > 0) return Math.max(1, Math.floor(hard * 0.8));
    const raw = Number(process.env.OMNI_TURN_SOFT_TOKEN_BUDGET);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return 5_000_000;
  }
}
