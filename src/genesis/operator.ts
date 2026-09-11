/**
 * 算子指称语义（Denotational operator semantics）。
 *
 * 设计意图：把"一次系统变换"统一建模为**纯函数**
 *   `Operator<S> = (state: S) => { next: S; cost: Cost; events: Event[] }`
 * 这是整个架构"经得住推理演算"的核心——
 *   - 纯函数 ⇒ 无隐藏副作用，可等式推理；
 *   - 组合 `composeOperator` 构成**幺半群**（结合律 + 单位元 `identityOperator`）；
 *   - 成本经 Cost 幺半群累加，与组合顺序无关。
 *
 * 既有的九个仿生算子（heatAnnealer / immuneMonitoring / symmetryBreaking /
 * capabilityCrystallizer / …）均可包装为 `Operator<HarnessState>`，从而落入
 * 同一代数，无需重写——这是"整体全新且能力强大"而非"堆砌"的关键：
 * 新内核提供统一语义，既有能力作为 lawful morphism 接入。
 *
 * @maturity L3 — composeOperator 组合律与 identityOperator 有单测
 * @maturityEvidence tests/unit/genesis.test.ts
 */

import { type Cost, type Monoid, emptyCost, concatCost } from './algebra.js';

/** 算子执行结果：下一状态 + 本次成本 + 事件轨迹（审计/可重放）。 */
export interface OperatorResult<S> {
  readonly next: S;
  readonly cost: Cost;
  readonly events: ReadonlyArray<string>;
}

/** 算子：状态的纯变换（指称语义）。 */
export type Operator<S> = (state: S) => OperatorResult<S>;

/** 单位元算子：状态不变、零成本、无事件。 */
export function identityOperator<S>(): Operator<S> {
  return (s: S) => ({ next: s, cost: emptyCost, events: [] });
}

/** 算子组合（幺半群 concat）：先 a 后 b，成本累加，事件拼接。 */
export function composeOperator<S>(a: Operator<S>, b: Operator<S>): Operator<S> {
  return (s: S) => {
    const r1 = a(s);
    const r2 = b(r1.next);
    return {
      next: r2.next,
      cost: concatCost(r1.cost, r2.cost),
      events: [...r1.events, ...r2.events],
    };
  };
}

/** Operator<S> 上的幺半群实例（组合幺半群，非交换）。 */
export const operatorMonoid = <S>(): Monoid<Operator<S>> => ({
  empty: () => identityOperator<S>(),
  concat: (a, b) => composeOperator(a, b),
});

/**
 * 把"纯状态步进函数"提升为算子（零成本、无事件）。
 * 既有算子若形式为 `(s) => s` 可直接接入代数。
 */
export function liftOperator<S>(step: (s: S) => S): Operator<S> {
  return (s: S) => ({ next: step(s), cost: emptyCost, events: [] });
}

/**
 * 把带成本的步进函数提升为算子。
 */
export function liftCosted<S>(step: (s: S) => { next: S; cost: Cost }): Operator<S> {
  return (s: S) => {
    const r = step(s);
    return { next: r.next, cost: r.cost, events: [] };
  };
}
