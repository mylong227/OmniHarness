/**
 * 分桶候选档案（GEE Kernel v1 · ② expand 环的存储面，ADR-0008）。
 *
 * MAP-Elites 式精英保留：候选按**工况桶**分桶存放（桶语义由调用方声明），桶内按得分
 * 保留精英、超出容量淘汰低分者——修「所有候选挤在同一比较空间」的失败根因。
 *
 * 冻结语义（本实现的两个保留 reason 约定，端口文件已载）：
 * - `promoted`：**永久退役**——已晋升者进入技能注册表，绝不复活、绝不重入候选流；
 * - 其它 reason（如 `rejected:...`）：**暂停**——负结果留档不删除，同工况桶复现时
 *   由 `reviveFor` 复活（防「评估集偏差判死好变异」）。
 *
 * 确定性：桶内排序恒为（得分降序，同分按入档序）；同键重入档 = 全新条目（清冻结状态）。
 *
 * @maturity L1 — 分桶/冻结/复活判据钉死（含变异判据）；桶语义依赖调用方声明
 * @maturityEvidence tests/unit/evolutionKernel.test.ts
 */
import type { ArchivedCandidate, CandidateArchivePort } from '../ports/runtime/evolution.js';
import type { Candidate } from '../ports/runtime/evolution.js';

/** 永久退役冻结 reason（约定值：reviveFor 不复活，见模块注释）。 */
const RETIRED_REASON = 'promoted';

/** 分桶候选档案选项。 */
export interface BucketedCandidateArchiveOptions {
  /** 每工况桶保留精英上限（默认 4；超出淘汰桶内低分者，防无界膨胀）。 */
  readonly maxPerBucket?: number | undefined;
}

/** 分桶候选档案：按工况桶保留精英 + 冻结不删除 + 同工况复活。 */
export class BucketedCandidateArchive implements CandidateArchivePort {
  /** 每桶容量上限。 */
  private readonly maxPerBucket: number;
  /** 工况桶 → 桶内条目（插入序；读取时按得分排序）。 */
  private readonly buckets = new Map<string, ArchivedCandidate[]>();
  /** 候选键（技能名）→ 当前条目（冻结寻址用；被淘汰/重入档时同步）。 */
  private readonly byKey = new Map<string, ArchivedCandidate>();
  /** 入档序号（同分确定性排序）。 */
  private nextSeq = 0;

  /**
   * @param opts 每桶容量上限（缺省 4）
   */
  public constructor(opts: BucketedCandidateArchiveOptions = {}) {
    this.maxPerBucket = Math.max(1, Math.floor(opts.maxPerBucket ?? 4));
  }

  /**
   * 入档：放入指定工况桶（同键重入档视为全新条目，清冻结状态；桶超限淘汰低分者）。
   * @param candidate 待入档候选
   * @param bucketKey 工况桶键
   * @param score 精英得分
   * @returns 无返回值（void）
   */
  public put(candidate: Candidate, bucketKey: string, score: number): void {
    const key = candidate.skill.name;
    const previous = this.byKey.get(key);
    if (previous !== undefined) {
      this.removeFromBucket(previous);
      this.byKey.delete(key);
    }
    const entry: ArchivedCandidate = {
      candidate,
      bucketKey,
      score,
      seq: this.nextSeq++,
    };
    const bucket = this.buckets.get(bucketKey) ?? [];
    bucket.push(entry);
    this.buckets.set(bucketKey, bucket);
    this.sortBucket(bucket);
    this.byKey.set(key, entry);
    this.trim(bucket);
  }

  /**
   * 桶内未冻结精英（得分降序，同分按入档序）。
   * @param bucketKey 工况桶键
   * @returns 精英条目快照副本
   */
  public elites(bucketKey: string): readonly ArchivedCandidate[] {
    return (this.buckets.get(bucketKey) ?? []).filter((e) => e.frozenReason === undefined);
  }

  /**
   * 冻结（不删除）：按候选键标记冻结；已永久退役者保持退役（reason 不可降级）。
   * @param key 候选键（技能名）
   * @param reason 冻结原因
   * @returns true = 存在条目且已冻结；false = 无此条目
   */
  public freeze(key: string, reason: string): boolean {
    const entry = this.byKey.get(key);
    if (entry === undefined) return false;
    if (entry.frozenReason !== RETIRED_REASON) {
      this.byKey.set(key, { ...entry, frozenReason: reason });
      this.replaceInBucket(entry, this.byKey.get(key)!);
    }
    return true;
  }

  /**
   * 工况复现复活：解冻该桶全部**非退役**冻结条目并返回（得分降序）；`promoted` 退役者不动。
   * @param bucketKey 工况桶键
   * @returns 复活条目（快照副本；无冻结条目为空数组）
   */
  public reviveFor(bucketKey: string): readonly ArchivedCandidate[] {
    const bucket = this.buckets.get(bucketKey) ?? [];
    const revived: ArchivedCandidate[] = [];
    for (const entry of bucket) {
      if (entry.frozenReason === undefined || entry.frozenReason === RETIRED_REASON) continue;
      const thawed: ArchivedCandidate = { ...entry, frozenReason: undefined };
      this.replaceInBucket(entry, thawed);
      this.byKey.set(entry.candidate.skill.name, thawed);
      revived.push(thawed);
    }
    return revived;
  }

  /**
   * 桶内排序（得分降序，同分按入档序——确定性）。
   * @param bucket 桶条目数组（就地排序）
   * @returns 无返回值（void）
   */
  private sortBucket(bucket: ArchivedCandidate[]): void {
    bucket.sort((a, b) => b.score - a.score || a.seq - b.seq);
  }

  /**
   * 淘汰桶内低分者至容量上限（被淘汰条目同步摘除冻结寻址）。
   * @param bucket 桶条目数组（已排序）
   * @returns 无返回值（void）
   */
  private trim(bucket: ArchivedCandidate[]): void {
    while (bucket.length > this.maxPerBucket) {
      const dropped = bucket.pop();
      if (dropped !== undefined && this.byKey.get(dropped.candidate.skill.name) === dropped) {
        this.byKey.delete(dropped.candidate.skill.name);
      }
    }
  }

  /**
   * 从其所在桶移除条目（同键换桶时）。
   * @param entry 旧条目
   * @returns 无返回值（void）
   */
  private removeFromBucket(entry: ArchivedCandidate): void {
    const bucket = this.buckets.get(entry.bucketKey);
    if (bucket === undefined) return;
    const index = bucket.indexOf(entry);
    if (index >= 0) bucket.splice(index, 1);
  }

  /**
   * 就地替换桶内条目（保持位置，重新排序）。
   * @param oldEntry 旧条目
   * @param newEntry 新条目
   * @returns 无返回值（void）
   */
  private replaceInBucket(oldEntry: ArchivedCandidate, newEntry: ArchivedCandidate): void {
    const bucket = this.buckets.get(oldEntry.bucketKey);
    if (bucket === undefined) return;
    const index = bucket.indexOf(oldEntry);
    if (index >= 0) bucket[index] = newEntry;
    this.sortBucket(bucket);
  }
}
