/**
 * 推理强度任务自适应路由器（T5.5 · RLVR 训练信号 / 成本治理）。
 *
 * 解决的问题：推理强度（reasoning effort）一刀切——简单任务烧高推理预算（token 浪费），
 * 困难任务给低预算（质量塌）。路由器按**任务难度分层**给档：易 → low，中 → medium，
 * 难 → high。难度由显式规则评分（长度 / 代码块 / 多步标记 / 约束数），确定性、可复算。
 *
 * 成本口径（可证伪）：路由后「易任务档位下降、难任务档位不变」⇒ 同 workload 总推理
 * 预算持平或下降，而难任务不受影响。档位 → 预算系数表显式列出，禁暗改。
 *
 * @maturity L1 — 难度评分是显式规则；成本结论由测试断言（易任务档位降、难任务档位不变）
 * @maturityEvidence tests/unit/reasoningRouter.test.ts
 */

/** 推理档位（与 model 端口 reasoning effort 同名同序）。 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** 每档位相对预算系数（同模型下推理 token 的近似相对量，显式表禁暗改）。 */
export const EFFORT_COST: Readonly<Record<ReasoningEffort, number>> = Object.freeze({
  low: 1,
  medium: 3,
  high: 8,
});

/** 路由阈值：score ≤ 1 → low；2..3 → medium；≥ 4 → high。 */
const ROUTE_LOW_MAX = 1;
const ROUTE_MEDIUM_MAX = 3;

/** 难度评分结果明细（审计用：每条规则的贡献可逐项核对）。 */
export interface DifficultyBreakdown {
  /** 总分（0..7）。 */
  readonly total: number;
  /** 各规则贡献：长度 / 代码块 / 多步标记 / 约束密度。 */
  readonly byRule: Readonly<Record<'length' | 'codeBlock' | 'multiStep' | 'constraints', number>>;
}

/**
 * 推理档位路由器：任务文本 → 难度分 → 档位 → 预算对比。
 * 无状态（同输入恒同结果），实例化承载阈值常量并保持 OO 一致性（D9：新代码禁顶层函数）。
 */
export class ReasoningRouter {
  /** 难度评分权重（显式规则）。 */
  private static readonly WEIGHTS = Object.freeze({
    length: 1, // 超 500 字符
    codeBlock: 2, // 含代码块（``` 围栏）
    multiStep: 2, // 多步标记（先…再…然后/step1/①②③ 等）
    constraints: 1, // 每 2 个约束词计 1 分，封顶 2
  } as const);
  /** 约束词表（与 WEIGHTS.constraints 配套）。 */
  private static readonly CONSTRAINT_PATTERN = /必须|不得|同时|至少|不超过/g;
  /** 多步标记模式。 */
  private static readonly MULTI_STEP_PATTERN =
    /先[^。]{0,30}(再|然后)|step\s*1|①|第一步|multi[- ]step/i;

  /**
   * 任务难度评分（确定性，0..7）。
   * @param task 任务文本
   * @returns 难度分与逐规则明细
   */
  public difficulty(task: string): DifficultyBreakdown {
    const byRule = {
      length: task.length > 500 ? ReasoningRouter.WEIGHTS.length : 0,
      codeBlock: task.includes('```') ? ReasoningRouter.WEIGHTS.codeBlock : 0,
      multiStep: ReasoningRouter.MULTI_STEP_PATTERN.test(task)
        ? ReasoningRouter.WEIGHTS.multiStep
        : 0,
      constraints:
        Math.min(2, Math.floor((task.match(ReasoningRouter.CONSTRAINT_PATTERN) ?? []).length / 2)) *
        ReasoningRouter.WEIGHTS.constraints,
    };
    return {
      total: byRule.length + byRule.codeBlock + byRule.multiStep + byRule.constraints,
      byRule,
    };
  }

  /**
   * 由难度分路由推理档位。
   * @param score 难度分（difficulty 产物）
   * @returns 档位：≤1 low；2..3 medium；≥4 high
   */
  public routeByScore(score: number): ReasoningEffort {
    if (score <= ROUTE_LOW_MAX) return 'low';
    if (score <= ROUTE_MEDIUM_MAX) return 'medium';
    return 'high';
  }

  /**
   * 一步到位：任务文本 → 推理档位。
   * @param task 任务文本
   * @returns 档位
   */
  public route(task: string): ReasoningEffort {
    return this.routeByScore(this.difficulty(task).total);
  }

  /**
   * 路由前后总预算对比（可证伪口径的机械器）。
   * @param tasks 任务列表
   * @param fixed 固定档位（对照：一刀切，默认 high）
   * @returns 两种策略的总预算系数与差额（negative = 路由更省）
   */
  public compareBudgets(
    tasks: readonly string[],
    fixed: ReasoningEffort = 'high',
  ): { routedTotal: number; fixedTotal: number; delta: number } {
    const routedTotal = tasks.map((t) => this.route(t)).reduce((acc, e) => acc + EFFORT_COST[e], 0);
    const fixedTotal = tasks.length * EFFORT_COST[fixed];
    return { routedTotal, fixedTotal, delta: routedTotal - fixedTotal };
  }
}
