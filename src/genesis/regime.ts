/**
 * 自适应元控制器（Adaptive meta-controller）。
 *
 * "架构适应力强"的正式表达：系统随**工况（Regime）**自动重配置算子管线，
 * 且重配置本身是**纯函数** `plan: Regime -> Operator<GenesisState>`，
 * 因此可被等式推理与测试。
 *
 * 数学收敛性（可推演）：熵为模态种类的**派生量**（香农熵），
 * 基本算子只做两件严格"收缩"的事：
 *   - 融合（fuse）：模态数 ≥ 3 时合并两个为 tensor ⇒ 模态数严格减少；
 *   - 剪枝（prune）：成本压力 > 0.7 时丢弃最低优先级模态 ⇒ 模态数减少。
 * 二者均只减不增，模态数有下界（≥1），故反复应用必在有限步内到达**不动点**
 * （长度不再变化 ⇒ plan 退化为恒等）。这是对"自适应收敛"的可证明保证，
 * 而非启发式承诺。冷却（退火）在此等价于"通过融合冗余模态降低熵"。
 */

import { type Cost, cost, emptyCost } from './algebra.js';
import { type ModalityKind } from './modality.js';
import {
  type Operator,
  type OperatorResult,
  identityOperator,
  composeOperator,
} from './operator.js';
import { shannon } from './mathutil.js';

/** Genesis 内部控制状态（自包含，不耦合完整 harness）。 */
export interface GenesisState {
  /** 当前激活的模态集合。 */
  readonly modalities: ReadonlyArray<ModalityKind>;
  /** 能量/成本预算。 */
  readonly budget: Cost;
  /** 已花费。 */
  readonly spent: Cost;
  /** 步数（用于可重放/审计）。 */
  readonly step: number;
}

/** 工况（规划者视角）。 */
export interface Regime {
  /** 派生熵：模态种类的香农熵。 */
  readonly entropy: number;
  readonly modalities: ReadonlyArray<ModalityKind>;
  /** 成本压力 ∈ [0,1]：spent/budget。 */
  readonly costPressure: number;
}

/** 由模态分布派生香农熵（信息论 grounding）。 */
export function deriveEntropy(modalities: ReadonlyArray<ModalityKind>): number {
  const kinds = modalities.length || 1;
  const counts = new Map<string, number>();
  for (const m of modalities) counts.set(m, (counts.get(m) ?? 0) + 1);
  const probs: number[] = [];
  for (const c of counts.values()) probs.push(c / kinds);
  return shannon(probs);
}

/** 由状态提取工况（用于重规划，形成闭环）。 */
export function characteristicRegime(s: GenesisState): Regime {
  const pressure = s.budget.tokens > 0 ? s.spent.tokens / s.budget.tokens : 1;
  return { entropy: deriveEntropy(s.modalities), modalities: s.modalities, costPressure: pressure };
}

function costRatio(s: GenesisState): number {
  return s.budget.tokens > 0 ? s.spent.tokens / s.budget.tokens : 1;
}

// ---- 两个基本收缩算子（纯函数，指称语义） ----

/**
 * 融合算子（冷却/降熵）：模态数 ≥ 3 时把前两个融合为 tensor。
 * 模态数严格减少 ⇒ 构成收敛的良基度量。
 */
export const fuseOperator: Operator<GenesisState> = (
  s: GenesisState,
): OperatorResult<GenesisState> => {
  if (s.modalities.length < 3) return { next: s, cost: emptyCost, events: [] };
  const rest = s.modalities.slice(2);
  return { next: { ...s, modalities: ['tensor', ...rest] }, cost: cost(15), events: ['fuse'] };
};

/**
 * 剪枝算子（降本）：成本压力 > 0.7 时确定性丢弃最低优先级模态（首元素）。
 * 单调性：高压力 ⇒ 模态数减少；低压力 ⇒ 恒等（no-op）。
 */
export const pruneOperator: Operator<GenesisState> = (
  s: GenesisState,
): OperatorResult<GenesisState> => {
  const pressure = costRatio(s);
  if (pressure <= 0.7 || s.modalities.length <= 1) {
    return { next: s, cost: emptyCost, events: [] };
  }
  const next = s.modalities.slice(1);
  return { next: { ...s, modalities: next }, cost: cost(40), events: ['prune'] };
};

/**
 * 规划：依工况条件组合基本算子（纯函数）。
 * 返回单体算子（以 identity 为起始，顺序 compose）。
 */
export function plan(regime: Regime): Operator<GenesisState> {
  const ops: Operator<GenesisState>[] = [];
  if (regime.entropy > 0.5 && regime.modalities.length >= 3) ops.push(fuseOperator);
  if (regime.costPressure > 0.7) ops.push(pruneOperator);
  return ops.reduce<Operator<GenesisState>>(
    (acc, o) => composeOperator(acc, o),
    identityOperator<GenesisState>(),
  );
}

/**
 * 单次自适应步进：感知工况 → 规划 → 应用 → 累计花费。
 * 用于集成演示与测试（配合 Ledger 守恒律）。
 */
export function adaptOnce(
  state: GenesisState,
  ledger: { record: (c: Cost) => void },
): GenesisState {
  const regime = characteristicRegime(state);
  const op = plan(regime);
  const r = op(state);
  ledger.record(r.cost);
  return {
    ...r.next,
    spent: {
      tokens: state.spent.tokens + r.cost.tokens,
      joules: state.spent.joules + r.cost.joules,
    },
    step: state.step + 1,
  };
}
