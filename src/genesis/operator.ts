/**
 * 算子指称语义（Denotational operator semantics）。
 *
 * 设计意图：把"一次系统变换"统一建模为**纯函数**
 *   `OperatorFn<S> = (state: S) => { next: S; cost: Cost; events: Event[] }`
 * 这是整个架构"经得住推理演算"的核心——
 *   - 纯函数 ⇒ 无隐藏副作用，可等式推理；
 *   - 组合 `composeOperator` 构成**幺半群**（结合律 + 单位元 `identityOperator`）；
 *   - 成本经 Cost 幺半群累加，与组合顺序无关。
 *
 * 既有的九个仿生算子（heatAnnealer / immuneMonitoring / symmetryBreaking /
 * capabilityCrystallizer / …）均可包装为 `OperatorFn<HarnessState>`，从而落入
 * 同一代数，无需重写——这是"整体全新且能力强大"而非"堆砌"的关键：
 * 新内核提供统一语义，既有能力作为 lawful morphism 接入。
 *
 * @maturity L3 — composeOperator 组合律/单位元 + lift 同态律（lift(g∘f) ≡ lift(f)∘lift(g)、
 *                lift(id) ≡ identityOperator）均有单测（T1.1）
 * @maturityEvidence tests/unit/genesis.test.ts
 */

import { type Cost, type Monoid, emptyCost, Algebra } from './algebra.js';

/**
 * OperatorFn —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class Operator {
  /** 单位元算子：状态不变、零成本、无事件。 */
  public static identityOperator<S>(): OperatorFn<S> {
    return (s: S) => ({ next: s, cost: emptyCost, events: [] });
  }

  /** 算子组合（幺半群 concat）：先 a 后 b，成本累加，事件拼接。 */
  public static composeOperator<S>(a: OperatorFn<S>, b: OperatorFn<S>): OperatorFn<S> {
    return (s: S) => {
      const r1 = a(s);
      const r2 = b(r1.next);
      return {
        next: r2.next,
        cost: Algebra.concatCost(r1.cost, r2.cost),
        events: [...r1.events, ...r2.events],
      };
    };
  }

  /**
   * 把"纯状态步进函数"提升为算子（零成本、无事件）。
   * 既有算子若形式为 `(s) => s` 可直接接入代数。
   */
  public static liftOperator<S>(step: (s: S) => S): OperatorFn<S> {
    return (s: S) => ({ next: step(s), cost: emptyCost, events: [] });
  }

  /**
   * 把带成本的步进函数提升为算子。
   */
  public static liftCosted<S>(step: (s: S) => { next: S; cost: Cost }): OperatorFn<S> {
    return (s: S) => {
      const r = step(s);
      return { next: r.next, cost: r.cost, events: [] };
    };
  }
}

/** 算子执行结果：下一状态 + 本次成本 + 事件轨迹（审计/可重放）。 */
export interface OperatorResult<S> {
  readonly next: S;
  readonly cost: Cost;
  readonly events: ReadonlyArray<string>;
}

/** 算子：状态的纯变换（指称语义）。 */
export type OperatorFn<S> = (state: S) => OperatorResult<S>;

/** OperatorFn<S> 上的幺半群实例（组合幺半群，非交换）。 */
export const operatorMonoid = <S>(): Monoid<OperatorFn<S>> => ({
  empty: () => Operator.identityOperator<S>(),
  concat: (a, b) => Operator.composeOperator(a, b),
});
