/**
 * @maturity L2 — 序贯重要性重采样；有效样本数与退化处理决定成败
 * @maturityEvidence tests/unit/particleFilter.test.ts
 */
import type {
  MetacognitionPort,
  BeliefSnapshot,
  BeliefUpdateReport,
} from '../../ports/intelligence/metacognition.js';
import { klDiagonal, reparamInvariant } from '../../util/beliefMath.js';

/** 粒子滤波信念选项（fail-closed 边界夹紧）。 */
export interface ParticleFilterOptions {
  /** 状态维度（默认 3）。 */
  readonly dim?: number;
  /** 粒子数（默认 200）。 */
  readonly particles?: number;
  /** 初始均值（默认 0）。 */
  readonly initialMean?: number;
  /** 初始方差（默认 1，须 > 0）。 */
  readonly initialVariance?: number;
  /** 重采样阈值：有效样本数 ESS 低于 particles·resampleRatio 时重采样（默认 0.5）。 */
  readonly resampleRatio?: number;
  /** 自然步进抖动幅度（默认 0.05）。 */
  readonly jitter?: number;
  /** 随机种子（默认 0x9e3779b9，保证测试可复现）。 */
  readonly seed?: number;
}

/** 确定性 PRNG（mulberry32），避免测试依赖全局 Math.random。
 * @param seed 随机种子（同一种子产出同一序列，保证可复现）。
 * @returns 每次调用返回 [0,1) 均匀分布随机数的抽样函数。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态抽样（Box–Muller）。
 * @param rng 均匀分布随机源（[0,1)；0 值会被循环重抽以避免对数发散）。
 * @returns 一个标准正态分布 N(0,1) 抽样值。
 */
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 粒子滤波信念引擎（Particle-Filter Belief，I-P2-3）。
 *
 * 信念 = 一组带权粒子 {(x_i, w_i)} 对状态后验的蒙特卡洛近似。两类更新：
 * - `correct`：给定观测与似然噪声，对粒子按高斯似然重加权；归一化后若有效样本数 ESS 过低则
 *   系统重采样（防权值退化）。后验经加权高斯拟合后给出可审计 KL 分解。
 * - `naturalStep`：每个粒子沿梯度方向推进一步 + 抖动（粒子版自然梯度上升）。
 *
 * fail-closed：观测离所有粒子极远（似然全溢出）时不崩溃——权值保持均匀、置信记 0、快照仍有效。
 * 零依赖、可复现（种子化 PRNG）。
 */
export class ParticleFilterBelief implements MetacognitionPort {
  /** 端口名：粒子滤波信念标识，与 MetacognitionPort 契约的命名空间一致。 */
  public readonly name = 'particle-filter-belief';
  /** 状态维度（下限 1）。 */
  private readonly dim: number;
  /** 粒子数（下限 2）。 */
  private readonly n: number;
  /** 重采样触发阈值：ESS 低于该值即系统重采样（resampleRatio × n，下限 0.01n）。 */
  private readonly resampleFloor: number;
  /** 每步抖动幅度（下限 0），用于维持粒子多样性。 */
  private readonly jitter: number;
  /** 种子化 PRNG 抽样函数（mulberry32）。 */
  private readonly rng: () => number;
  /** 粒子集：n × dim 的状态样本矩阵。 */
  private particles: number[][];
  /** 各粒子权值（恒归一化；均匀分布初始化）。 */
  private weights: number[];

  /**
   * 构造信念引擎：按选项夹紧参数并以初始高斯 N(initialMean, initialVariance) 抽取初始粒子。
   * @param opts 选项（全部缺省：dim=3、particles=200、均值 0、方差 1、resampleRatio=0.5、
   *             jitter=0.05、种子 0x9e3779b9）。
   */
  public constructor(opts: ParticleFilterOptions = {}) {
    this.dim = Math.max(1, Math.floor(opts.dim ?? 3));
    this.n = Math.max(2, Math.floor(opts.particles ?? 200));
    this.resampleFloor = Math.max(0.01, opts.resampleRatio ?? 0.5) * this.n;
    this.jitter = Math.max(0, opts.jitter ?? 0.05);
    this.rng = mulberry32(opts.seed ?? 0x9e3779b9);
    const m0 = opts.initialMean ?? 0;
    const v0 = Math.max(1e-3, opts.initialVariance ?? 1);
    const sd = Math.sqrt(v0);
    this.particles = [];
    this.weights = new Array<number>(this.n).fill(1 / this.n);
    for (let i = 0; i < this.n; i++) {
      const p: number[] = [];
      for (let d = 0; d < this.dim; d++) p.push(m0 + sd * randn(this.rng));
      this.particles.push(p);
    }
  }

  /** 加权高斯拟合：由当前粒子集与权值计算加权均值、加权方差与有效样本数。
   * @returns mean 为加权均值向量，variance 为加权方差向量，ess 为有效样本数 1/Σw²（退化度量）。
   */
  private fit(): { mean: number[]; variance: number[]; ess: number } {
    const mean = new Array<number>(this.dim).fill(0);
    let wsum = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.weights[i]!;
      wsum += w;
      for (let d = 0; d < this.dim; d++) mean[d] = mean[d]! + w * this.particles[i]![d]!;
    }
    if (wsum > 0) for (let d = 0; d < this.dim; d++) mean[d] = mean[d]! / wsum;
    const variance = new Array<number>(this.dim).fill(0);
    for (let i = 0; i < this.n; i++) {
      const w = this.weights[i]!;
      for (let d = 0; d < this.dim; d++) {
        const diff = this.particles[i]![d]! - mean[d]!;
        variance[d] = variance[d]! + w * diff * diff;
      }
    }
    let ess = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.weights[i]!;
      ess += w * w;
    }
    ess = ess > 0 ? 1 / ess : 0;
    return { mean, variance, ess };
  }

  /**
   * 当前信念快照：粒子集按权值加权拟合的对角高斯（均值/方差）。
   * @returns 置信摘要 = ESS/N（有效样本比，权重健康度；权值均衡→1，单粒子主导→趋 0）。
   */
  public snapshot(): BeliefSnapshot {
    const { mean, variance, ess } = this.fit();
    // 置信摘要 = 有效样本比 ESS/N（权重健康度，粒子滤波标准退化度量）：
    // 权值均衡→1（健康），单粒子主导→趋 0（退化）。与方差解耦——低方差既可能是"确信"也可能是
    // "坍缩"，单凭方差无法区分，故置信只度量权重健康。
    const confidence = Math.max(0, Math.min(1, ess / this.n));
    return { mean, variance, confidence };
  }

  /**
   * 观测修正：按高斯似然重加权粒子（log 域稳定归一化，防 exp 下溢）；有效样本数 ESS
   * 低于重采样阈值时系统重采样。fail-closed：观测离所有粒子极远（似然全溢出）时权值保持均匀、不崩溃。
   * @param observation 观测向量（缺失维度按 0 处理）。
   * @param observationNoise 观测噪声（标准差，默认 1）。
   * @returns 可审计 KL 分解报告。
   */
  public correct(observation: readonly number[], observationNoise = 1): BeliefUpdateReport {
    const before = this.snapshot();
    const noise2 = Math.max(1e-6, observationNoise * observationNoise);
    const dim = this.dim;
    const logW: number[] = new Array<number>(this.n).fill(0);
    let maxLog = -Infinity;
    for (let i = 0; i < this.n; i++) {
      let ll = 0;
      for (let d = 0; d < dim; d++) {
        const diff = (observation[d] ?? 0) - this.particles[i]![d]!;
        ll += (-0.5 * (diff * diff)) / noise2;
      }
      ll -= 0.5 * dim * Math.log(2 * Math.PI * noise2);
      logW[i] = ll;
      if (ll > maxLog) maxLog = ll;
    }
    // 稳定归一化：减去最大值防 exp 下溢。
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      const w = Math.exp(logW[i]! - maxLog);
      this.weights[i] = w;
      sum += w;
    }
    if (!isFinite(sum) || sum <= 0) {
      // fail-closed：观测离所有粒子极远 → 权值溢出，保持均匀、置信记 0，不崩溃。
      for (let i = 0; i < this.n; i++) this.weights[i] = 1 / this.n;
    } else {
      for (let i = 0; i < this.n; i++) this.weights[i] = this.weights[i]! / sum;
    }
    const ess = this.effectiveSampleSize();
    if (ess < this.resampleFloor) this.resample();
    return this.report(before);
  }

  /**
   * 粒子版自然梯度上升：每个粒子沿梯度推进一步，并叠加按各维标准差缩放的随机抖动（种子化 PRNG，可复现）。
   * @param gradient 梯度向量（缺失维度按 0 处理）。
   * @param learningRate 步进学习率（默认 0.1，负值夹紧为 0）。
   * @returns 可审计 KL 分解报告。
   */
  public naturalStep(gradient: readonly number[], learningRate = 0.1): BeliefUpdateReport {
    const before = this.snapshot();
    const lr = Math.max(0, learningRate);
    const { variance } = this.fit();
    const sd = variance.map((v) => Math.sqrt(Math.max(v, 1e-6)));
    for (let i = 0; i < this.n; i++) {
      const p = this.particles[i]!;
      for (let d = 0; d < this.dim; d++) {
        p[d] = p[d]! + lr * (gradient[d] ?? 0) + this.jitter * sd[d]! * randn(this.rng);
      }
    }
    return this.report(before);
  }

  /** 计算有效样本数 ESS = 1/Σw²（权值越均衡越大，单粒子主导时趋 1）。
   * @returns 当前权值分布的有效样本数；权值全 0 时为 0。
   */
  private effectiveSampleSize(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.weights[i]!;
      s += w * w;
    }
    return s > 0 ? 1 / s : 0;
  }

  /** 系统重采样：按累积权值确定性抽取，重置权值为均匀（防权值退化）。复制时加微小抖动（roughening），避免粒子逐位相同导致样本贫困。
   * @returns 无返回值。
   */
  private resample(): void {
    const cum: number[] = [];
    let acc = 0;
    for (let i = 0; i < this.n; i++) {
      acc += this.weights[i]!;
      cum.push(acc);
    }
    const step = 1 / this.n;
    let j = 0;
    const next: number[][] = [];
    for (let i = 0; i < this.n; i++) {
      const target = (i + this.rng()) * step;
      while (j < this.n - 1 && target > cum[j]!) j++;
      const src = this.particles[j]!;
      const p: number[] = new Array<number>(this.dim);
      for (let d = 0; d < this.dim; d++) p[d] = src[d]! + this.jitter * randn(this.rng);
      next.push(p);
    }
    this.particles = next;
    for (let i = 0; i < this.n; i++) this.weights[i] = 1 / this.n;
  }

  /** 生成更新前后的可审计报告（快照对 + 对角 KL + 重参数化不变量）。
   * @param before 更新前的信念快照。
   * @returns 含 before/after 快照、KL 散度与重参数化不变量的更新报告。
   */
  private report(before: BeliefSnapshot): BeliefUpdateReport {
    const after = this.snapshot();
    const kl = klDiagonal(
      after.mean as number[],
      after.variance as number[],
      before.mean as number[],
      before.variance as number[],
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
