/**
 * Genesis 代数骨架（Algebraic backbone）。
 *
 * 设计意图：把"能耗 / 成本"建模为一个**可推理的交换幺半群（commutative monoid）**，
 * 使整个系统的资源计量具备代数结构——满足结合律与单位元律，可被单元测试机械证明。
 * 这是"数学层面经得住推理演算"的基石：任何算子组合的成本 = 各算子成本之幺半群和，
 * 与组合顺序无关（交换性），且空操作不耗资源（单位元）。
 *
 * 注意：`joules` 是**估算代理值**（每 token 的经验系数），真实硬件需实测校准；
 * 这里的关键不是物理精度，而是代数结构（交换幺半群）的严格成立，用于守恒律推演。
 *
 * @maturity L3 — 结合律/单位元/交换律有单测，可组合推演
 * @maturityEvidence tests/unit/genesis.test.ts
 */

/** 资源成本：token 计量 + 能耗代理值（单位：估算焦耳）。 */
export interface Cost {
  /** 语言模型 token 数（真实计量来源：ModelUsage）。 */
  readonly tokens: number;
  /** 能耗代理值（估算）。真实硬件需实测，此处仅为代数守恒演示。 */
  readonly joules: number;
}

/** 每 token 的能耗代理估算系数（焦耳）。标注为估算，禁止当真实测量值使用。 */
export const JOULES_PER_TOKEN_ESTIMATE = 1e-6;

/** 幺半群单位元：零成本。 */
export const emptyCost: Cost = Object.freeze({ tokens: 0, joules: 0 });

/** 由 token 数构造成本（joules 为估算代理）。 */
export function cost(tokens: number): Cost {
  const t = Math.abs(tokens);
  return { tokens: t, joules: t * JOULES_PER_TOKEN_ESTIMATE };
}

/** 幺半群 concat：逐维相加。实数加法 ⇒ 结合律 + 交换律严格成立。 */
export function concatCost(a: Cost, b: Cost): Cost {
  return { tokens: a.tokens + b.tokens, joules: a.joules + b.joules };
}

/**
 * 半群接口（泛型，供后续结构复用）。
 */
export interface Semigroup<A> {
  readonly concat: (a: A, b: A) => A;
}

/**
 * 幺半群接口 = 半群 + 单位元。
 */
export interface Monoid<A> extends Semigroup<A> {
  readonly empty: () => A;
}

/** Cost 的幺半群实例（交换幺半群）。 */
export const costMonoid: Monoid<Cost> = {
  empty: () => emptyCost,
  concat: concatCost,
};

/**
 * 数值向量上的自由交换幺半群：逐维相加，单位元为零向量。
 * 用于多维资源（token / 算力 / 存储 / 网络）的统一计量骨架。
 */
export function vectorConcat(a: readonly number[], b: readonly number[]): number[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  }
  return out;
}

export function vectorEmpty(length: number): number[] {
  return new Array<number>(length).fill(0);
}
