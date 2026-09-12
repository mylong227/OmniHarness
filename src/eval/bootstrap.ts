/**
 * 确定性 bootstrap 重采样助手（Pass@k 置信区间，T4.7）。
 *
 * 与 `evals/layered-recall-ab.mjs` 的 `bootstrapGain` **同一方法**（有放回重采样 +
 * 2.5 / 97.5 分位），区别在于此处用**种子化 PRNG**（mulberry32）使之**可复现**。
 * 这正是 T4.7 的关键：门禁若用未固定种子的重采样，判定本身会随机红/绿——
 * 用点阈值判 Pass@k 的旧行为即此病灶；种子固定后同一输入恒得同一区间与结论。
 *
 * 零依赖。
 */

/** 默认种子（固定常数，保证同一输入下门禁判定可复现）。 */
export const DEFAULT_BOOTSTRAP_SEED = 0x9e3779b9;

/** bootstrap 区间结果。 */
export interface BootstrapResult {
  /** 重采样统计量的均值。 */
  readonly mean: number;
  /** 下分位（默认 2.5%）。 */
  readonly lo: number;
  /** 上分位（默认 97.5%）。 */
  readonly hi: number;
  /** 实际重采样次数。 */
  readonly rounds: number;
}

/** bootstrap 选项。 */
export interface BootstrapOptions {
  /** 重采样次数（默认 2000，与 T2 的方法一致）。 */
  readonly rounds?: number;
  /** PRNG 种子（默认 {@link DEFAULT_BOOTSTRAP_SEED}）；同种子同结果。 */
  readonly seed?: number;
  /** 显著性水平（默认 0.05 ⇒ 95% 置信区间）。 */
  readonly alpha?: number;
}

/**
 * mulberry32：32 位种子化 PRNG，返回 [0,1) 均匀采样函数。
 *
 * @param seed 32 位无符号种子
 * @returns 每次调用返回一个 [0,1) 均匀随机数；同种子产生同序列
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 最近秩分位数（nearest-rank），`sorted` 必须已升序。
 * 索引取 `min(len-1, floor(p*len))`，与 T2 `bootstrapGain` 的取法一致。
 *
 * @param sorted 升序数组
 * @param p 分位比例，自动夹取到 [0,1]
 * @returns 分位值；空数组返回 0
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const idx = Math.min(sorted.length - 1, Math.floor(clamped * sorted.length));
  const value = sorted[idx];
  return value === undefined ? 0 : value;
}

/**
 * 对 `items` 做有放回重采样 `rounds` 次，每次计算 `statistic(resample)`，
 * 返回统计量分布的均值与 95% 置信区间。统计量由调用方注入（Pass@k / 增益均可复用）。
 *
 * @param items 观测样本（此处为「每任务」的分组结果）
 * @param statistic 作用于一次重采样的统计量
 * @param opts 次数 / 种子 / 显著性（可选）
 * @returns 统计量的 `{ mean, lo, hi, rounds }`
 */
export function bootstrapInterval<T>(
  items: readonly T[],
  statistic: (resample: readonly T[]) => number,
  opts: BootstrapOptions = {},
): BootstrapResult {
  const rounds = Math.max(1, Math.floor(opts.rounds ?? 2000));
  const alpha = opts.alpha ?? 0.05;
  const n = items.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, rounds };

  const rand = mulberry32(opts.seed ?? DEFAULT_BOOTSTRAP_SEED);
  const dist = new Array<number>(rounds);
  for (let b = 0; b < rounds; b++) {
    const resample = new Array<T>(n);
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rand() * n);
      resample[i] = items[k]!;
    }
    dist[b] = statistic(resample);
  }
  dist.sort((a, b) => a - b);
  const mean = dist.reduce((s, v) => s + v, 0) / rounds;
  return {
    mean,
    lo: percentile(dist, alpha / 2),
    hi: percentile(dist, 1 - alpha / 2),
    rounds,
  };
}
