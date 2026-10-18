import type { StepRewardSample } from '../ports/memory/processReward.ts';

/** 训练选项。 */
export interface ProcessRewardTrainOptions {
  /** 训练轮数（默认 400）。 */
  readonly epochs?: number;
  /** 学习率（默认 0.1）。 */
  readonly learningRate?: number;
  /** L2 正则（默认 0.01）。 */
  readonly l2?: number;
}

/** 评测指标。 */
export interface ProcessRewardMetrics {
  /** 样本数。 */
  readonly samples: number;
  /** AUC（某类为空时 NaN）。 */
  readonly auc: number;
  /** Brier。 */
  readonly brier: number;
  /** 准确率（阈值 0.5）。 */
  readonly accuracy: number;
}

/** 序列化模型。 */
export interface ProcessRewardModelJson {
  readonly kind: 'logistic-prm-v1';
  readonly weights: readonly number[];
  readonly means: readonly number[];
  readonly stds: readonly number[];
}

/**
 * 判别式步骤 PRM 基线（logistic，标准可复现训练/评测）。
 *
 * 不是 GenPRM：没有语言模型生成推理；它只回答「给定步骤特征，测试通过概率」。
 * 特征：noul、目标数（log1p 归一）、工具是否写类。用于建立**可验收基线**，
 * 后续 GenPRM 必须在这条基线上做配对对比。
 */
export class LogisticProcessReward {
  /** 特征均值。 */
  private readonly means: readonly number[];
  /** 特征标准差。 */
  private readonly stds: readonly number[];
  /** 权重（含 bias）。 */
  private readonly weights: readonly number[];

  /**
   * @param weights 权重
   * @param means 特征均值
   * @param stds 特征标准差
   */
  private constructor(
    weights: readonly number[],
    means: readonly number[],
    stds: readonly number[],
  ) {
    this.weights = weights;
    this.means = means;
    this.stds = stds;
  }

  /**
   * 训练模型（确定性全批量梯度下降；按验证集早停）。
   * @param train 训练样本
   * @param val 验证样本
   * @param options 训练选项
   * @returns 模型
   */
  public static train(
    train: readonly StepRewardSample[],
    val: readonly StepRewardSample[],
    options: ProcessRewardTrainOptions = {},
  ): LogisticProcessReward {
    const trainRows = LogisticProcessReward.rows(train);
    const valRows = LogisticProcessReward.rows(val);
    if (trainRows.length < 10) throw new Error('PRM 训练样本不足（至少 10 条有 noul 的样本）');
    if (!trainRows.some((row) => row.y === 1) || !trainRows.some((row) => row.y === 0)) {
      throw new Error('PRM 训练集必须同时包含通过与失败样本');
    }
    const means: number[] = [];
    const stds: number[] = [];
    for (let column = 0; column < trainRows[0]!.x.length; column += 1) {
      const values = trainRows.map((row) => row.x[column] ?? 0);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      means.push(mean);
      stds.push(Math.sqrt(variance) || 1);
    }
    const normalize = (x: readonly number[]): number[] => [
      1,
      ...x.map((value, index) => (value - (means[index] ?? 0)) / (stds[index] ?? 1)),
    ];
    const rows = trainRows.map((row) => ({ x: normalize(row.x), y: row.y }));
    const valRowsNorm = valRows.map((row) => ({ x: normalize(row.x), y: row.y }));
    let weights = new Array<number>(rows[0]!.x.length).fill(0);
    const epochs = Math.max(1, Math.floor(options.epochs ?? 400));
    const learningRate = options.learningRate ?? 0.1;
    const l2 = options.l2 ?? 0.01;
    let bestWeights = [...weights];
    let bestLoss = Number.POSITIVE_INFINITY;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const gradient = new Array<number>(weights.length).fill(0);
      for (const row of rows) {
        const error =
          LogisticProcessReward.sigmoid(LogisticProcessReward.dot(weights, row.x)) - row.y;
        for (let index = 0; index < weights.length; index += 1) {
          gradient[index] = (gradient[index] ?? 0) + error * (row.x[index] ?? 0);
        }
      }
      for (let index = 0; index < weights.length; index += 1) {
        gradient[index] =
          (gradient[index] ?? 0) / rows.length + (index === 0 ? 0 : l2 * (weights[index] ?? 0));
      }
      weights = weights.map((weight, index) => weight - learningRate * (gradient[index] ?? 0));
      const loss = LogisticProcessReward.loss(valRowsNorm.length > 0 ? valRowsNorm : rows, weights);
      if (loss < bestLoss) {
        bestLoss = loss;
        bestWeights = [...weights];
      }
    }
    return new LogisticProcessReward(bestWeights, means, stds);
  }

  /**
   * 单样本通过概率。
   * @param sample 步骤样本
   * @returns [0,1]
   */
  public predict(sample: StepRewardSample): number {
    const x = LogisticProcessReward.features(sample);
    const normalized = [
      1,
      ...x.map((value, index) => (value - (this.means[index] ?? 0)) / (this.stds[index] ?? 1)),
    ];
    return LogisticProcessReward.sigmoid(LogisticProcessReward.dot(this.weights, normalized));
  }

  /**
   * 评测指标。
   * @param samples 样本
   * @returns AUC/Brier/准确率
   */
  public evaluate(samples: readonly StepRewardSample[]): ProcessRewardMetrics {
    const rows = LogisticProcessReward.rows(samples);
    if (rows.length === 0)
      return { samples: 0, auc: Number.NaN, brier: Number.NaN, accuracy: Number.NaN };
    const scored = rows.map((row) => ({ p: this.predict({ ...row.raw }), y: row.y }));
    const positives = scored.filter((row) => row.y === 1).map((row) => row.p);
    const negatives = scored.filter((row) => row.y === 0).map((row) => row.p);
    return {
      samples: scored.length,
      auc: LogisticProcessReward.auc(positives, negatives),
      brier: scored.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / scored.length,
      accuracy: scored.filter((row) => (row.p >= 0.5 ? 1 : 0) === row.y).length / scored.length,
    };
  }

  /**
   * 序列化（供推理端口/离线复用）。
   * @returns JSON 对象
   */
  public toJson(): ProcessRewardModelJson {
    return {
      kind: 'logistic-prm-v1',
      weights: [...this.weights],
      means: [...this.means],
      stds: [...this.stds],
    };
  }

  /**
   * 反序列化。
   * @param json 模型 JSON
   * @returns 模型
   */
  public static fromJson(json: ProcessRewardModelJson): LogisticProcessReward {
    if (json.kind !== 'logistic-prm-v1') throw new Error('未知 PRM 模型格式');
    return new LogisticProcessReward(json.weights, json.means, json.stds);
  }

  /**
   * 特征抽取：noul、目标数、工具是否写类。
   * @param sample 样本
   * @returns 特征
   */
  private static features(sample: StepRewardSample): number[] {
    const writes = ['write_file', 'edit', 'apply_patch', 'patch_candidates'];
    return [
      Math.min(1, Math.max(0, sample.noul ?? 0.5)),
      Math.log1p(Math.min(10, sample.targets.length)) / Math.log(11),
      writes.includes(sample.toolName) ? 1 : 0,
    ];
  }

  /**
   * 构造训练行。
   * @param samples 样本
   * @returns 行
   */
  private static rows(
    samples: readonly StepRewardSample[],
  ): { readonly x: number[]; readonly y: number; readonly raw: StepRewardSample }[] {
    return samples
      .filter((sample) => typeof sample.noul === 'number' && Number.isFinite(sample.noul))
      .map((sample) => ({
        x: LogisticProcessReward.features(sample),
        y: sample.passed ? 1 : 0,
        raw: sample,
      }));
  }

  /**
   * 点积。
   * @param weights 权重
   * @param x 特征
   * @returns 分数
   */
  private static dot(weights: readonly number[], x: readonly number[]): number {
    return weights.reduce((sum, weight, index) => sum + weight * (x[index] ?? 0), 0);
  }

  /**
   * Sigmoid。
   * @param value 输入
   * @returns (0,1)
   */
  private static sigmoid(value: number): number {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exp = Math.exp(value);
    return exp / (1 + exp);
  }

  /**
   * Logistic loss。
   * @param rows 行
   * @param weights 权重
   * @returns loss
   */
  private static loss(
    rows: readonly { readonly x: readonly number[]; readonly y: number }[],
    weights: readonly number[],
  ): number {
    if (rows.length === 0) return 0;
    const epsilon = 1e-9;
    return (
      -rows.reduce((sum, row) => {
        const p = Math.min(
          1 - epsilon,
          Math.max(
            epsilon,
            LogisticProcessReward.sigmoid(LogisticProcessReward.dot(weights, row.x)),
          ),
        );
        return sum + row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p);
      }, 0) / rows.length
    );
  }

  /**
   * Mann-Whitney AUC。
   * @param positives 正类概率
   * @param negatives 负类概率
   * @returns AUC
   */
  private static auc(positives: readonly number[], negatives: readonly number[]): number {
    if (positives.length === 0 || negatives.length === 0) return Number.NaN;
    let wins = 0;
    for (const positive of positives) {
      for (const negative of negatives) {
        if (positive > negative) wins += 1;
        else if (positive === negative) wins += 0.5;
      }
    }
    return wins / (positives.length * negatives.length);
  }
}
