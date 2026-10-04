/**
 * 覆盖率分桶闸（GEE Kernel v1 · ④ gate 环的工况纪律，ADR-0008 / EVOLVIX_SPEC §4 F1）。
 *
 * 解决的问题：历史口径把全体样本的势函数覆盖率**平均**成一个数——只要多数候选来自
 * 「验证命令好跑」的工况，少数「命令跑不动」的工况就被平均值掩盖（本仓实测反复出现的
 * 失败根因：在错误的比较空间里看指标）。分桶之后取**最差桶**做闸：任何一类工况的验证
 * 覆盖率不达标，整轮就不放行——闸只可能更保守，绝不因为平均而放行。
 *
 * 口径纪律（判据钉死）：
 * - 阈值**沿用** {@link COVERAGE_THRESHOLD}（不改口径：闸变严靠分桶取最差，不靠调阈值）；
 * - `coverage` = 最差桶覆盖率（无桶时退化为全局覆盖率，与单一口径逐字等价）；
 * - 分桶口径恒 **≤** 全局口径（数学性质：最小桶均值 ≤ 全体均值）——健康且均匀的样本集上
 *   两者相等，故「不劣化健康场景」与「不放过拥挤桶」同时成立；
 * - 逐桶明细按桶键升序（确定性），最差桶并列时取字典序最小者（同输入恒同裁决）。
 *
 * @maturity L1 — 分桶取最差的闸判据钉死（含「去分桶即漏放」的变异判据）；分桶收益未统计
 * @maturityEvidence tests/unit/bucketedCoverageMeter.test.ts
 */
import { RewardCoverageMeter } from './rewardCoverageMeter.js';
import type {
  CoverageMeter,
  CoverageReportSurface,
  RewardCoverageReport,
  RewardVerdict,
} from './rewardCoverageMeter.js';

/** 工况桶键派生（缺省 {@link BucketedCoverageMeter.sourceBucket}）。 */
export type CoverageBucketKey = (candidate: unknown) => string;

/** 分桶覆盖率计量器选项。 */
export interface BucketedCoverageMeterOptions {
  /** 工况桶键派生（缺省 = 候选 `meta.source` 的算子前缀，无来源归 `unknown`）。 */
  readonly bucketFor?: CoverageBucketKey | undefined;
}

/**
 * 分桶覆盖率计量器：同一样本**同时**记进全局口径与所属工况桶，
 * `report().coverage` 取最差桶（闸自动变保守），全局口径保留供对照。
 */
export class BucketedCoverageMeter implements CoverageMeter {
  /** 工况桶键派生。 */
  private readonly bucketFor: CoverageBucketKey;
  /** 全局口径计量器（对照 + 无桶退化）。 */
  private readonly global = new RewardCoverageMeter();
  /** 工况桶 → 计量器。 */
  private readonly meters = new Map<string, RewardCoverageMeter>();

  /**
   * @param opts 工况桶键派生（缺省取 `meta.source` 算子前缀）
   */
  public constructor(opts: BucketedCoverageMeterOptions = {}) {
    this.bucketFor = opts.bucketFor ?? BucketedCoverageMeter.sourceBucket;
  }

  /**
   * 默认工况桶键：候选 `meta.source` 的算子前缀（`twist:a+b` → `twist`；无来源 → `unknown`）。
   * @param candidate 采样候选（`CodeCandidate` 形状，来源经 `meta.source` 由采样上下文注入）
   * @returns 工况桶键
   */
  public static sourceBucket(candidate: unknown): string {
    const meta = BucketedCoverageMeter.metaOf(candidate);
    const source = meta?.['source'];
    if (typeof source !== 'string' || source.length === 0) return 'unknown';
    const sep = source.indexOf(':');
    return sep > 0 ? source.slice(0, sep) : source;
  }

  /**
   * 取候选的 `meta` 对象（非对象/缺失一律 undefined——分桶派生绝不抛错）。
   * @param candidate 候选
   * @returns meta 记录或 undefined
   */
  private static metaOf(candidate: unknown): Record<string, unknown> | undefined {
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const meta = (candidate as { readonly meta?: unknown }).meta;
    if (typeof meta !== 'object' || meta === null) return undefined;
    return meta as Record<string, unknown>;
  }

  /**
   * 包装探针：逐样本记进全局与该样本所属工况桶（探针**只求值一次**，结论记进两处）。
   * @param probe 带判据明细的探针
   * @returns 与既有 VerifiableRewardFn 兼容的数值奖励
   */
  public wrap(probe: {
    verify(candidate: unknown): Promise<RewardVerdict>;
  }): (candidate: unknown) => Promise<number> {
    return async (candidate) => {
      // 桶键派生失败不得影响奖励（观测纪律）：异常 → 归 unknown 桶。
      let bucket = 'unknown';
      try {
        bucket = this.bucketFor(candidate);
      } catch {
        bucket = 'unknown';
      }
      let meter = this.meters.get(bucket);
      if (meter === undefined) {
        meter = new RewardCoverageMeter();
        this.meters.set(bucket, meter);
      }
      // 一次求值、两处记账：分桶绝不让真实验证（spawn）多跑一次。
      const verdict = await RewardCoverageMeter.verdictOf(probe, candidate);
      this.global.record(verdict);
      meter.record(verdict);
      return verdict.reward;
    };
  }

  /**
   * 出体检报告：全局口径 + 逐桶明细（桶键升序 → 最差桶并列时取字典序最小者，确定性）。
   * @returns 分桶覆盖率报告
   */
  public report(): BucketedCoverageReport {
    const buckets: BucketCoverageEntry[] = [...this.meters.entries()]
      .map(([bucket, meter]) => {
        const report = meter.report();
        return { bucket, samples: report.samples, coverage: report.coverage, report };
      })
      .sort((a, b) => a.coverage - b.coverage || (a.bucket < b.bucket ? -1 : 1));
    return new BucketedCoverageReport(this.global.report(), buckets);
  }

  /**
   * 清空记录（新一轮体检；全局与各桶一并清）。
   * @returns 无返回值（void）
   */
  public reset(): void {
    this.global.reset();
    for (const meter of this.meters.values()) meter.reset();
  }
}

/** 单桶覆盖率条目（体检报告明细）。 */
export interface BucketCoverageEntry {
  /** 工况桶键。 */
  readonly bucket: string;
  /** 该桶样本数。 */
  readonly samples: number;
  /** 该桶真实可验证判定占比（0..1）。 */
  readonly coverage: number;
  /** 该桶完整覆盖率报告（含诚实表述）。 */
  readonly report: RewardCoverageReport;
}

/** 分桶覆盖率体检报告值对象（闸只认 {@link CoverageReportSurface} 的保守取值与诚实表述）。 */
export class BucketedCoverageReport implements CoverageReportSurface {
  /** 全局口径报告（全体样本，保留供对照与观测）。 */
  public readonly global: RewardCoverageReport;
  /** 逐桶明细（覆盖率升序，同覆盖率按桶键升序 —— 确定性）。 */
  public readonly buckets: readonly BucketCoverageEntry[];

  /**
   * @param global 全局口径报告
   * @param buckets 逐桶明细（调用方保证已按最差优先排序）
   */
  public constructor(global: RewardCoverageReport, buckets: readonly BucketCoverageEntry[]) {
    this.global = global;
    this.buckets = buckets;
  }

  /** 最差工况桶的报告（无桶时为 undefined；覆盖率并列取字典序最小桶）。 */
  public get worst(): RewardCoverageReport | undefined {
    return this.buckets[0]?.report;
  }

  /** 最差工况桶键（无桶时为 undefined）。 */
  public get worstBucket(): string | undefined {
    return this.buckets[0]?.bucket;
  }

  /** 闸用覆盖率：最差桶口径（无桶退化为全局）。 */
  public get coverage(): number {
    return this.worst?.coverage ?? this.global.coverage;
  }

  /** 诚实表述：点名最差桶 + 沿用既有降级措辞（诚实口径只有一处实现）。 */
  public get honestNote(): string {
    const base = (this.worst ?? this.global).honestNote;
    return this.worstBucket === undefined ? base : `最差工况桶 ${this.worstBucket}：${base}`;
  }

  /** 逐桶覆盖率明细（闸与观测的共用形状）。 */
  public get bucketCoverage(): readonly {
    readonly bucket: string;
    readonly samples: number;
    readonly coverage: number;
  }[] {
    return this.buckets.map((b) => ({
      bucket: b.bucket,
      samples: b.samples,
      coverage: b.coverage,
    }));
  }
}
