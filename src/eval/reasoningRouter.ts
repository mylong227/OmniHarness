/**
 * 推理强度任务自适应路由（T5.5 · RLVR 训练信号 / 成本治理）。
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

/** 难度评分权重（显式规则）。 */
const W_LENGTH_500 = 1; // 超 500 字符
const W_CODE_BLOCK = 2; // 含代码块（``` 围栏）
const W_MULTI_STEP = 2; // 多步标记（先…再…然后/step1/①②③ 等）
const W_CONSTRAINTS = 1; // 约束/边界词（必须/不得/同时/至少 每出现 2 个计 1 分，封顶 2）

/** 路由阈值：score ≤ 1 → low；2..3 → medium；≥ 4 → high。 */
const ROUTE_LOW_MAX = 1;
const ROUTE_MEDIUM_MAX = 3;

/**
 * 任务难度评分（确定性，0..7）。
 * @param task 任务文本
 * @returns 难度分：长度 + 代码块 + 多步标记 + 约束密度
 */
export function taskDifficultyScore(task: string): number {
  let score = 0;
  if (task.length > 500) score += W_LENGTH_500;
  if (task.includes('```')) score += W_CODE_BLOCK;
  if (/先[^。]{0,30}(再|然后)|step\s*1|①|第一步|multi[- ]step/i.test(task)) score += W_MULTI_STEP;
  const constraintHits = (task.match(/必须|不得|同时|至少|不超过/g) ?? []).length;
  score += Math.min(2, Math.floor(constraintHits / 2)) * W_CONSTRAINTS;
  return score;
}

/**
 * 由难度分路由推理档位。
 * @param score 难度分（taskDifficultyScore 产物）
 * @returns 档位：≤1 low；2..3 medium；≥4 high
 */
export function routeByScore(score: number): ReasoningEffort {
  if (score <= ROUTE_LOW_MAX) return 'low';
  if (score <= ROUTE_MEDIUM_MAX) return 'medium';
  return 'high';
}

/**
 * 一步到位：任务文本 → 推理档位。
 * @param task 任务文本
 * @returns 档位
 */
export function routeReasoning(task: string): ReasoningEffort {
  return routeByScore(taskDifficultyScore(task));
}

/**
 * 路由前后总预算对比（可证伪口径的机械器）。
 * @param tasks 任务列表
 * @param fixed 固定档位（对照：一刀切）
 * @returns 两种策略的总预算系数与差额（negative = 路由更省）
 */
export function budgetCompare(
  tasks: readonly string[],
  fixed: ReasoningEffort = 'high',
): { routedTotal: number; fixedTotal: number; delta: number } {
  const routedTotal = tasks.map(routeReasoning).reduce((acc, e) => acc + EFFORT_COST[e], 0);
  const fixedTotal = tasks.length * EFFORT_COST[fixed];
  return { routedTotal, fixedTotal, delta: routedTotal - fixedTotal };
}
