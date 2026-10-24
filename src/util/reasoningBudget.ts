import type { ModelRole } from '../ports/model/modelRole.ts';

/** 推理强度合法档位（与配置/厂商预设一致）。 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 推理预算分层（2026-10-23，成本优化）。
 *
 * ## 为什么需要
 *
 * 本机真实会话里 reasoning 文本约 34 万字符、completion 19 万 token；按 chars/3 粗估，
 * 推理约占输出 **59%**（鹈鹕会话约 73%）。原先 `runtime.config.reasoning` 被原样传给
 * 所有步骤与所有辅助角色（压缩/记忆/目标/guardian/reviewer），简单问答也按同一档思考。
 *
 * ## 策略（`OMNI_REASONING_POLICY=balanced`，缺省）
 *
 * - **executor**：用户显式配置优先；未配置时复杂任务 `high`、简单任务 `low`；
 * - **辅助角色**：用户配置为 `none/minimal/low` 时保持，否则压到 `low`（结构化任务不需要
 *   高强度思考；压缩摘要/记忆蒸馏/目标判定尤其如此）；
 * - **off**：逐字回到旧行为（未配置即 `undefined`，由端点默认）。
 *
 * ## 诚实边界
 *
 * 这是**成本/延迟**策略，不是准确率证明：翻默认前应用 `tools/eval/harnessAb.mjs` 做
 * 任务级 A/B（k≥3）。`off` 是逃生口；`configured` 显式值对 executor 永远优先。
 */
export class ReasoningBudget {
  /** 环境变量名：`balanced`（缺省）/ `off`。 */
  public static readonly ENV = 'OMNI_REASONING_POLICY';

  /** 低强度档集合（辅助角色可保留的档位）。 */
  private static readonly LOW_TIERS: ReadonlySet<string> = new Set(['none', 'minimal', 'low']);

  /**
   * executor 的推理强度。
   * @param configured 用户显式配置（`runtime.config.reasoning`；可为 undefined）。
   * @param complex 是否复杂多步任务（`TaskComplexityClassifier.assess(prompt).complex`）。
   * @param env 环境变量表（注入以便单测）。
   * @returns 推理强度；`undefined` 表示不显式下发（端点默认）。
   */
  public static executor(
    configured: ReasoningEffort | undefined,
    complex: boolean,
    env: Record<string, string | undefined> = process.env,
  ): ReasoningEffort | undefined {
    if (!ReasoningBudget.enabled(env)) {
      return configured;
    }
    if (configured !== undefined) {
      return configured;
    }
    return complex ? 'high' : 'low';
  }

  /**
   * 辅助角色的推理强度：结构化任务压到低档，但不把用户显式的 `none/minimal/low` 抬高。
   * @param role 角色（用于未来按角色细分；当前统一低档）。
   * @param configured 用户显式配置。
   * @param env 环境变量表。
   * @returns 推理强度；`off` 策略下原样返回 configured。
   */
  public static auxiliary(
    role: ModelRole,
    configured: ReasoningEffort | undefined,
    env: Record<string, string | undefined> = process.env,
  ): ReasoningEffort | undefined {
    if (!ReasoningBudget.enabled(env)) {
      return configured;
    }
    void role;
    const base = configured ?? 'low';
    return ReasoningBudget.LOW_TIERS.has(base) ? base : 'low';
  }

  /**
   * 是否启用分层策略。
   * @param env 环境变量表。
   * @returns 非 `off` 即启用（大小写/空白不敏感）。
   */
  public static enabled(env: Record<string, string | undefined> = process.env): boolean {
    return env[ReasoningBudget.ENV]?.trim().toLowerCase() !== 'off';
  }
}
