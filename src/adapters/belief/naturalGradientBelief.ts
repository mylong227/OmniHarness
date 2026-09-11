/**
 * @maturity L2 — 用自然梯度方向；流形假设未验证（待复核，或应降 L1）
 * @maturityEvidence tests/unit/naturalGradient.test.ts
 */
import type {
  MetacognitionPort,
  BeliefSnapshot,
  BeliefUpdateReport,
} from '../../ports/metacognition.js';
import { klDiagonal, reparamInvariant } from '../../util/beliefMath.js';

/** 自然梯度信念选项（fail-closed 边界夹紧）。 */
export interface NaturalGradientOptions {
  /** 信念维度（默认 3）。 */
  readonly dim?: number;
  /** 初始均值（默认 0）。 */
  readonly initialMean?: number;
  /** 初始方差（默认 1，须 > 0）。 */
  readonly initialVariance?: number;
  /** 方差地板（防退化，默认 1e-3）。 */
  readonly varianceFloor?: number;
}

/**
 * 自然梯度信念引擎（Natural-Gradient Belief，I-P2-2）。
 *
 * 把信念建模为对角高斯 N(μ, diag(σ²))。两类更新均返回可审计 KL 分解：
 * - `naturalStep`：自然梯度（信息几何）——均值沿逆 Fisher 度规（逆对角协方差 F=diag(1/σ²)）
 *   预处理步进：Δμ = η·σ²·g。这是自然梯度的定义性不变性（对重参数化协变）。
 * - `correct`：贝叶斯高斯更新——给定观测与似然噪声，闭式更新均值与方差（后验更集中）。
 *
 * 每次更新附 KL 分解（均值漂移 / 方差变化 / 逐维明细）+ 重参数化不变性审计。零依赖、fail-closed。
 */
export class NaturalGradientBelief implements MetacognitionPort {
  public readonly name = 'natural-gradient-belief';
  private readonly dim: number;
  private readonly floor: number;
  private mean: number[];
  private variance: number[];

  public constructor(opts: NaturalGradientOptions = {}) {
    this.dim = Math.max(1, Math.floor(opts.dim ?? 3));
    this.floor = Math.max(1e-6, opts.varianceFloor ?? 1e-3);
    const m0 = opts.initialMean ?? 0;
    const v0 = Math.max(this.floor, opts.initialVariance ?? 1);
    this.mean = new Array<number>(this.dim).fill(m0);
    this.variance = new Array<number>(this.dim).fill(v0);
  }

  public snapshot(): BeliefSnapshot {
    const totalVar = this.variance.reduce((a, b) => a + b, 0);
    // 置信摘要：方差越小越确信（归一化到 0..1，初始方差尺度为参考）。
    const confidence = Math.max(0, Math.min(1, 1 - totalVar / (this.dim * (this.floor + 4))));
    return {
      mean: this.mean.slice(),
      variance: this.variance.slice(),
      confidence,
    };
  }

  public naturalStep(gradient: readonly number[], learningRate = 0.1): BeliefUpdateReport {
    const before = this.snapshot();
    // 自然梯度：Δμ = η · F⁻¹ · g，对角 Fisher F=diag(1/σ²) ⇒ F⁻¹g = σ²·g。
    const lr = Math.max(0, learningRate);
    for (let i = 0; i < this.dim; i++) {
      const g = gradient[i] ?? 0;
      this.mean[i] = this.mean[i]! + lr * this.variance[i]! * g;
    }
    return this.report(before);
  }

  public correct(observation: readonly number[], observationNoise = 1): BeliefUpdateReport {
    const before = this.snapshot();
    const noise2 = Math.max(this.floor, observationNoise * observationNoise);
    for (let i = 0; i < this.dim; i++) {
      const precPrior = 1 / this.variance[i]!;
      const precLike = 1 / noise2;
      const precPost = precPrior + precLike;
      const vPost = 1 / precPost;
      const muPost = vPost * (this.mean[i]! * precPrior + (observation[i] ?? 0) * precLike);
      this.variance[i] = Math.max(this.floor, vPost);
      this.mean[i] = muPost;
    }
    return this.report(before);
  }

  private report(before: BeliefSnapshot): BeliefUpdateReport {
    const after = this.snapshot();
    const kl = klDiagonal(
      after.mean as number[],
      after.variance as number[],
      before.mean as number[],
      before.variance as number[],
      this.floor,
    );
    return {
      before,
      after,
      kl,
      reparamInvariant: reparamInvariant(
        after.mean as number[],
        after.variance as number[],
        before.mean as number[],
        before.variance as number[],
      ),
    };
  }
}
