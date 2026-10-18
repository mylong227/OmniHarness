import type { StepRewardSample } from '../ports/memory/processReward.ts';

/** 数据集切分。 */
export interface ProcessRewardSplit {
  /** 训练集。 */
  readonly train: readonly StepRewardSample[];
  /** 验证集（早停/选模）。 */
  readonly val: readonly StepRewardSample[];
  /** 测试集（只报告，不参与训练）。 */
  readonly test: readonly StepRewardSample[];
}

/** 切分选项。 */
export interface ProcessRewardSplitOptions {
  /** 随机种子（确定性；默认 7）。 */
  readonly seed?: number;
  /** 训练比例（默认 0.7）。 */
  readonly trainRatio?: number;
  /** 验证比例（默认 0.15）；其余为测试。 */
  readonly valRatio?: number;
}

/**
 * 步骤级 PRM 数据集切分（P3 标准管线）。
 *
 * 关键纪律：
 * - 只保留有 `noul` 的样本（没有预判特征无法训练校准模型）；
 * - **按 sessionId 分组切分**，同一会话绝不跨 train/val/test（防泄漏）；
 * - 无 sessionId 时按目标文件分组；同分组仍不拆分；
 * - 纯函数、确定性，便于复现。
 */
export class ProcessRewardDataset {
  /**
   * 切分数据集。
   * @param samples 原始步骤样本
   * @param options 切分选项
   * @returns 三路切分
   */
  public static split(
    samples: readonly StepRewardSample[],
    options: ProcessRewardSplitOptions = {},
  ): ProcessRewardSplit {
    const usable = samples.filter(
      (sample): sample is StepRewardSample & { noul: number } =>
        typeof sample.noul === 'number' && Number.isFinite(sample.noul),
    );
    const groups = new Map<string, (StepRewardSample & { noul: number })[]>();
    for (const sample of usable) {
      const key = sample.sessionId ?? `targets:${[...sample.targets].sort().join(',')}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(sample);
      groups.set(key, bucket);
    }
    const trainRatio = ProcessRewardDataset.ratio(options.trainRatio ?? 0.7);
    const valRatio = ProcessRewardDataset.ratio(options.valRatio ?? 0.15);
    const seed = Math.floor(options.seed ?? 7);
    const train: StepRewardSample[] = [];
    const val: StepRewardSample[] = [];
    const test: StepRewardSample[] = [];
    for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const position = ((ProcessRewardDataset.hash(key) + seed) % 1_000) / 1_000;
      const target = position < trainRatio ? train : position < trainRatio + valRatio ? val : test;
      target.push(...group);
    }
    return { train, val, test };
  }

  /**
   * 序列化为 JSONL（一行一个样本）。
   * @param samples 样本
   * @returns JSONL 文本
   */
  public static toJsonl(samples: readonly StepRewardSample[]): string {
    return (
      samples.map((sample) => JSON.stringify(sample)).join('\n') + (samples.length > 0 ? '\n' : '')
    );
  }

  /**
   * 比例夹取到 (0,1)。
   * @param value 原值
   * @returns 安全比例
   */
  private static ratio(value: number): number {
    return Number.isFinite(value) ? Math.min(0.95, Math.max(0.05, value)) : 0.7;
  }

  /**
   * FNV-1a 字符串哈希（确定性）。
   * @param text 文本
   * @returns 无符号 32 位
   */
  private static hash(text: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }
}
