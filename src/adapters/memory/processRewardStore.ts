import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ProcessRewardPort,
  StepRewardSample,
  StepRewardStats,
} from '../../ports/memory/processReward.ts';

/** 存储选项。 */
export interface ProcessRewardStoreOptions {
  /** 最多保留样本数（默认 500）。 */
  readonly maxEntries?: number;
  /** 可注入文件路径（缺省 `<workspace>/.omniharness/step-rewards.jsonl`）。 */
  readonly path?: string | undefined;
}

/**
 * 文件版步骤级过程奖励账本（JSONL；有界；原子写）。
 *
 * 与 `decision-traces` 的区别：后者是「noul vs 真实结果」的配对 trace；本账本只保留
 * 步骤级监督信号（工具/目标/通过率/可选 noul），用于按工具的先验与离线校准。
 */
export class ProcessRewardStore implements ProcessRewardPort {
  /** 最多保留条数。 */
  private readonly maxEntries: number;
  /** 存储路径。 */
  private readonly path: string;

  /**
   * @param workspaceRoot 工作区根。
   * @param options 存储选项。
   */
  public constructor(workspaceRoot: string, options: ProcessRewardStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 500));
    this.path = options.path ?? join(workspaceRoot, '.omniharness', 'step-rewards.jsonl');
  }

  /**
   * 记录一条样本（坏样本不写；保持有界）。
   * @param sample 样本
   * @returns 无返回值
   */
  public async record(sample: StepRewardSample): Promise<void> {
    const entries = await this.read();
    entries.push({
      ...sample,
      targets: [...sample.targets],
      ...(sample.noul === undefined ? {} : { noul: sample.noul }),
    });
    await this.write(entries.slice(-this.maxEntries));
  }

  /**
   * 统计校准/区分度；无 noul 时 AUC/Brier 为 NaN（不伪造数字）。
   * @returns 统计快照
   */
  public async stats(): Promise<StepRewardStats> {
    const entries = await this.read();
    const withNoul = entries.filter(
      (entry): entry is StepRewardSample & { noul: number } =>
        typeof entry.noul === 'number' && Number.isFinite(entry.noul),
    );
    const positives = withNoul.filter((entry) => entry.passed);
    const negatives = withNoul.filter((entry) => !entry.passed);
    const passRate =
      entries.length === 0 ? 0 : entries.filter((entry) => entry.passed).length / entries.length;
    return {
      samples: entries.length,
      passes: entries.filter((entry) => entry.passed).length,
      passRate,
      withNoul: withNoul.length,
      brier: withNoul.length === 0 ? Number.NaN : ProcessRewardStore.brier(withNoul),
      auc:
        positives.length === 0 || negatives.length === 0
          ? Number.NaN
          : ProcessRewardStore.auc(positives, negatives),
      lift:
        positives.length === 0 || negatives.length === 0
          ? Number.NaN
          : ProcessRewardStore.mean(positives.map((entry) => entry.noul)) -
            ProcessRewardStore.mean(negatives.map((entry) => entry.noul)),
    };
  }

  /**
   * 按工具名给出 Laplace 平滑通过率（无样本 0.5）。
   * @param toolName 工具名
   * @returns [0,1] 先验
   */
  public async predict(toolName: string): Promise<number> {
    const entries = (await this.read()).filter((entry) => entry.toolName === toolName);
    const passes = entries.filter((entry) => entry.passed).length;
    return (passes + 1) / (entries.length + 2);
  }

  /**
   * 读取条目（坏行跳过；文件不存在为空）。
   * @returns 样本数组
   */
  private async read(): Promise<StepRewardSample[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: StepRewardSample[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as StepRewardSample;
        if (ProcessRewardStore.isSample(row)) out.push(row);
      } catch {
        // 坏行跳过：过程奖励是增强数据，不是主状态。
      }
    }
    return out;
  }

  /**
   * 原子写入。
   * @param entries 条目
   * @returns 无返回值
   */
  private async write(entries: readonly StepRewardSample[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(
      tmp,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await rename(tmp, this.path);
  }

  /**
   * 形状校验。
   * @param value 反序列化值
   * @returns 可用时 true
   */
  private static isSample(value: unknown): value is StepRewardSample {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Partial<StepRewardSample>;
    return (
      typeof row.toolName === 'string' &&
      Array.isArray(row.targets) &&
      row.targets.every((target) => typeof target === 'string') &&
      typeof row.passed === 'boolean' &&
      (row.exitCode === null || typeof row.exitCode === 'number') &&
      typeof row.at === 'string' &&
      (row.noul === undefined || typeof row.noul === 'number')
    );
  }

  /**
   * Brier 分数。
   * @param entries 有 noul 的样本
   * @returns Brier
   */
  private static brier(entries: readonly (StepRewardSample & { noul: number })[]): number {
    return (
      entries.reduce((sum, entry) => sum + (entry.noul - (entry.passed ? 1 : 0)) ** 2, 0) /
      entries.length
    );
  }

  /**
   * Mann-Whitney AUC（ties=0.5）。
   * @param positives 通过样本
   * @param negatives 失败样本
   * @returns AUC
   */
  private static auc(
    positives: readonly (StepRewardSample & { noul: number })[],
    negatives: readonly (StepRewardSample & { noul: number })[],
  ): number {
    let wins = 0;
    for (const positive of positives) {
      for (const negative of negatives) {
        if (positive.noul > negative.noul) wins += 1;
        else if (positive.noul === negative.noul) wins += 0.5;
      }
    }
    return wins / (positives.length * negatives.length);
  }

  /**
   * 均值。
   * @param values 数值
   * @returns 均值
   */
  private static mean(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}
