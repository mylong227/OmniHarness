/**
 * @maturity L2 — 用自然梯度方向；流形假设未验证（待复核，或应降 L1）
 * @maturityEvidence tests/unit/naturalGradient.test.ts
 */
import type {
  MetacognitionPort,
  BeliefSnapshot,
  BeliefUpdateReport,
} from '../../ports/intelligence/metacognition.js';
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
  /** 端口名：自然梯度信念标识，与 MetacognitionPort 契约的命名空间一致。 */
  public readonly name = 'natural-gradient-belief';
  /** 信念维度（下限 1）。 */
  private readonly dim: number;
  /** 方差地板（防高斯退化为点质量）。 */
  private readonly floor: number;
  /** 对角高斯均值向量 μ。 */
  private mean: number[];
  /** 对角高斯方差向量 σ²（更新后夹紧不低于 floor）。 */
  private variance: number[];

  /**
   * 构造信念引擎：按选项夹紧参数并以 N(initialMean, initialVariance) 初始化各维。
   * @param opts 选项（全部缺省：dim=3、均值 0、方差 1、方差地板 1e-3）。
   */
  public constructor(opts: NaturalGradientOptions = {}) {
    this.dim = Math.max(1, Math.floor(opts.dim ?? 3));
    this.floor = Math.max(1e-6, opts.varianceFloor ?? 1e-3);
    const m0 = opts.initialMean ?? 0;
    const v0 = Math.max(this.floor, opts.initialVariance ?? 1);
    this.mean = new Array<number>(this.dim).fill(m0);
    this.variance = new Array<number>(this.dim).fill(v0);
  }

  /**
   * 当前信念快照（对角高斯均值 + 对角方差，返回副本）。
   * @returns 置信摘要 = 1 − 总方差/(dim·(floor+4))，夹紧到 0..1（方差越小越确信）。
   */
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

  /**
   * 自然梯度步进：均值按 Δμ = η·σ²·g（逆 Fisher 度规 = 逆对角协方差）预处理后更新，方差不变。
   * @param gradient 梯度向量（缺失维度按 0 处理）。
   * @param learningRate 学习率 η（默认 0.1，负值夹紧为 0）。
   * @returns 可审计 KL 分解报告（before/after/KL 分解/重参数化不变性审计）。
   */
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

  /**
   * 贝叶斯高斯观测修正：按精度（1/方差 + 1/噪声²）加权闭式更新均值与方差，
   * 后验更集中；更新后方差夹紧不低于地板。
   * @param observation 观测向量（缺失维度按 0 处理）。
   * @param observationNoise 观测噪声（标准差，默认 1；平方后夹紧不低于方差地板）。
   * @returns 可审计 KL 分解报告。
   */
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

  /** 生成更新前后的可审计报告（快照对 + 对角 KL + 重参数化不变量）。
   * @param before 更新前的信念快照。
   * @returns 含 before/after 快照、KL 分解与重参数化不变性审计的更新报告。
   */
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
