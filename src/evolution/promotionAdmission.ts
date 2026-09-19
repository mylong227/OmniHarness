/**
 * 晋升准入（T5.2 多样性闸 + T5.3 退火接受 + T4.3 失败模式挖掘的合流落点）。
 *
 * 解决的问题：RLVR 环里「过门禁 + 有绿样本」的候选此前**一律晋升**——这是 (1+1)-EA 的
 * 纯贪心接受，且对同 corpus 的近重复（Echo Trap）毫无抵抗：适应度还在涨，种群实际只剩
 * 一个回声。本器把两条既有机械判据钉进**同一条晋升路径**：
 *
 *   1. **多样性闸**（{@link DiversityGuard}）：按分数降序做「指纹配额」准入，超出配额的
 *      Echo 副本被拒（Echo Trap 的结构性防线）；
 *   2. **退火接受**（{@link AnnealedAcceptance}）：准入者之间按退火 Metropolis 准则决定
 *      是否让「分数略低者」顶替 incumbent——种子化 PRNG ⇒ 同种子同事件序列恒同结论。
 *
 * 同时把每一次失败（门禁未过 / RLVR 红样本 / 两个准入闸的拒绝 / 多样性塌缩）登记为
 * **失败记录**，交给 {@link FailurePatternMiner} 聚类升格为改进提案（防再犯方向），
 * 使「失败 → 提案」不再依赖人肉归纳。
 *
 * fail-closed 边界：本器**只做减法**——只可能把已晋升裁决改写为未晋升，绝不把未通过的
 * 候选改写成晋升（门禁/RLVR 的安全语义不可被准入层绕过）。
 */

import type { Candidate, PromotionVerdict } from '../ports/runtime/evolution.js';
import type { Skill } from '../skill/skill.js';
import { AnnealedAcceptance } from './annealedAcceptance.js';
import { DiversityGuard } from './diversityGuard.js';
import { FailurePatternMiner } from './failurePatternMiner.js';
import type { FailureRecord, ImprovementProposal } from './failurePatternMiner.js';

/** 准入层剔除记录（审计用：哪一级闸、依据是什么）。 */
export interface AdmissionRejection {
  /** 被剔除的候选。 */
  readonly candidate: Candidate;
  /** 剔除闸位：diversity = 指纹配额（Echo 副本）；annealing = 退火接受。 */
  readonly stage: 'diversity' | 'annealing';
  /** 人类可读依据（阈值 / 温度 / 概率 / 指纹）。 */
  readonly detail: string;
}

/** 准入结果。 */
export interface AdmissionResult {
  /** 重写后的裁决流（准入剔除项被改写为 promoted=false 并附理由；其余原样）。 */
  readonly verdicts: readonly PromotionVerdict[];
  /** 最终准入的候选（顺序与裁决流一致）。 */
  readonly promoted: readonly Candidate[];
  /** 被准入层剔除的候选明细。 */
  readonly rejections: readonly AdmissionRejection[];
  /** 多样性塌缩告警（去重率低于守卫阈值 ⇒ Echo Trap 风险）。 */
  readonly collapsed: boolean;
  /** 准入后种群去重率（distinct / admitted）。 */
  readonly distinctRatio: number;
  /** 失败模式挖掘产出的改进提案（对累积失败历史聚类，频次降序）。 */
  readonly proposals: readonly ImprovementProposal[];
}

/** 准入器选项（全部有保守默认）。 */
export interface PromotionAdmissionOptions {
  /** 退火接受器（默认 `new AnnealedAcceptance()`：种子 20260913、T0=1.0、cooling=0.95）。 */
  readonly acceptance?: AnnealedAcceptance | undefined;
  /** 多样性守卫（默认 `new DiversityGuard()`：同指纹配额 2）。 */
  readonly guard?: DiversityGuard | undefined;
  /** 失败模式挖掘器（默认 `new FailurePatternMiner()`：频次阈值 3）。 */
  readonly miner?: FailurePatternMiner | undefined;
}

/** 准入扫描条目（候选 + 裁决 + 在降序序列中的下标）。 */
interface AdmissionEntry {
  readonly verdict: PromotionVerdict;
  readonly index: number;
}

/** 准入层判定（哪一级闸剔除 + 依据）。 */
interface AdmissionBlock {
  readonly stage: 'diversity' | 'annealing';
  readonly detail: string;
}

/**
 * 晋升准入器：把「多样性闸 → 退火接受」两级判据叠在门禁/RLVR 裁决流之上，
 * 并把失败登记进失败模式挖掘器。
 *
 * 无状态外泄：实例持有退火温度与失败历史（跨轮累积，使频次阈值才有意义）。
 */
export class PromotionAdmission {
  /** 退火接受器（种子化 PRNG，温度单调不升）。 */
  private readonly acceptance: AnnealedAcceptance;
  /** 多样性守卫（指纹配额准入）。 */
  private readonly guard: DiversityGuard;
  /** 失败模式挖掘器（跨轮累积失败历史后聚类）。 */
  private readonly miner: FailurePatternMiner;
  /** 累积失败记录（跨轮：同一根因反复出现才够格升格为提案）。 */
  private readonly failures: FailureRecord[] = [];

  /**
   * @param opts 退火接受器 / 多样性守卫 / 失败挖掘器（缺省各取保守默认）
   */
  public constructor(opts: PromotionAdmissionOptions = {}) {
    this.acceptance = opts.acceptance ?? new AnnealedAcceptance();
    this.guard = opts.guard ?? new DiversityGuard();
    this.miner = opts.miner ?? new FailurePatternMiner();
  }

  /** 当前退火温度（单调不升；体检报告用）。 */
  public get temperature(): number {
    return this.acceptance.temperature;
  }

  /** 累积失败记录条数（体检报告用）。 */
  public get failureCount(): number {
    return this.failures.length;
  }

  /**
   * 准入判定：门禁（含 RLVR 阶段）已放行的候选，再经「多样性闸 → 退火接受」两级筛选。
   *
   * 只做减法：未通过的裁决原样返回，已通过的裁决可能被改写为未晋升（附闸位与依据）。
   *
   * @param verdicts 门禁（含 RLVR 阶段）产出的裁决流
   * @returns 准入结果（重写裁决 + 晋升候选 + 剔除明细 + 塌缩告警 + 改进提案）
   */
  public admit(verdicts: readonly PromotionVerdict[]): AdmissionResult {
    this.failures.push(...this.collectFailures(verdicts));
    const entries = this.orderByScore(verdicts);
    const diversity = this.applyDiversity(entries);
    const blocks = this.applyAnnealing(entries, diversity.admitted);
    const rewritten = this.rewrite(verdicts, entries, blocks);
    const promoted = rewritten.filter((v) => v.promoted).map((v) => v.candidate);
    const rejections = this.collectRejections(entries, blocks);
    this.recordAdmissionFailures(rejections);
    if (diversity.collapsed) {
      this.failures.push({
        kind: 'evolution:diversity-collapse',
        location: 'src/evolution/promotionAdmission.ts',
        message: `准入后去重率 ${diversity.distinctRatio.toFixed(3)} 低于守卫阈值（Echo Trap 风险）`,
      });
    }
    const { proposals } = this.miner.mine(this.failures);
    return {
      verdicts: rewritten,
      promoted,
      rejections,
      collapsed: diversity.collapsed,
      distinctRatio: diversity.distinctRatio,
      proposals,
    };
  }

  /**
   * 把准入层剔除登记为失败记录（防再犯提案的原料：同一闸反复拦同类候选即值得机制化）。
   * @param rejections 准入剔除明细
   * @returns 无返回值（void）
   */
  private recordAdmissionFailures(rejections: readonly AdmissionRejection[]): void {
    for (const r of rejections) {
      this.failures.push({
        kind: r.stage === 'diversity' ? 'evolution:echo-duplicate' : 'evolution:annealing-reject',
        location: this.domainOf(r.candidate),
        message: r.detail,
      });
    }
  }

  /**
   * 把门禁/RLVR 未通过的裁决登记为失败记录（按失败种类聚类）。
   * @param verdicts 裁决流
   * @returns 新增失败记录（含门禁与 RLVR 两类）
   */
  private collectFailures(verdicts: readonly PromotionVerdict[]): FailureRecord[] {
    const records: FailureRecord[] = [];
    for (const v of verdicts) {
      if (v.promoted) continue;
      records.push({
        kind: this.failureKind(v),
        location: this.domainOf(v.candidate),
        message: v.reason,
      });
    }
    return records;
  }

  /**
   * 失败种类归类：RLVR 红样本 / 安全检查拦截 / 门禁未达阈值。
   * @param verdict 未通过的裁决
   * @returns 失败种类键
   */
  private failureKind(verdict: PromotionVerdict): string {
    if (verdict.reason.includes('RLVR')) return 'eval:rlvr-red';
    if (verdict.safety === 'blocked') return 'gate:safety-blocked';
    return 'gate:below-threshold';
  }

  /**
   * 失败域：取候选来源的「算子前缀」（`twist:a+b` → `twist`），使同源失败可聚类计数。
   * @param candidate 候选
   * @returns 失败域键
   */
  private domainOf(candidate: Candidate): string {
    const sep = candidate.source.indexOf(':');
    return sep > 0 ? candidate.source.slice(0, sep) : candidate.source;
  }

  /**
   * 取出已放行的裁决并按分数降序排列（同分保持原序 ⇒ 判定确定）。
   * @param verdicts 裁决流
   * @returns 扫描条目（含原序下标，供回写）
   */
  private orderByScore(verdicts: readonly PromotionVerdict[]): AdmissionEntry[] {
    return verdicts
      .map((verdict, index) => ({ verdict, index }))
      .filter((e) => e.verdict.promoted)
      .sort((a, b) => b.verdict.score - a.verdict.score);
  }

  /**
   * 多样性闸：按指纹配额准入（Echo 副本超出配额者剔除）。
   * @param entries 降序扫描条目
   * @returns 守卫裁决 + 准入条目的原序下标集合
   */
  private applyDiversity(entries: readonly AdmissionEntry[]): {
    admitted: ReadonlySet<number>;
    collapsed: boolean;
    distinctRatio: number;
  } {
    const skills: Skill[] = entries.map((e) => e.verdict.candidate.skill);
    const verdict = this.guard.admit(skills);
    return {
      admitted: this.matchAdmitted(entries, verdict.admitted),
      collapsed: verdict.collapsed,
      distinctRatio: verdict.distinctRatio,
    };
  }

  /**
   * 把守卫准入的技能引用映射回扫描条目下标（同一技能对象可能多次出现，按序消费）。
   * @param entries 降序扫描条目
   * @param admitted 守卫准入的技能（与输入同引用、同相对顺序）
   * @returns 准入条目的原序下标集合
   */
  private matchAdmitted(
    entries: readonly AdmissionEntry[],
    admitted: readonly Skill[],
  ): ReadonlySet<number> {
    const queues = new Map<Skill, number[]>();
    for (const e of entries) {
      const skill = e.verdict.candidate.skill;
      const queue = queues.get(skill) ?? [];
      queue.push(e.index);
      queues.set(skill, queue);
    }
    const out = new Set<number>();
    for (const skill of admitted) {
      const next = queues.get(skill)?.shift();
      if (next !== undefined) out.add(next);
    }
    return out;
  }

  /**
   * 退火接受：多样性闸准入者之间按 Metropolis 准则决定是否让略低分者顶替 incumbent。
   * 首个准入者恒接受（无 incumbent）；此后 `decide(incumbent, score)` 由种子化 PRNG 判定。
   * @param entries 降序扫描条目
   * @param admitted 多样性闸准入的原序下标集合
   * @returns 原序下标 → 剔除判定（未剔除者不在表中）
   */
  private applyAnnealing(
    entries: readonly AdmissionEntry[],
    admitted: ReadonlySet<number>,
  ): Map<number, AdmissionBlock> {
    const blocks = new Map<number, AdmissionBlock>();
    let incumbent: number | undefined;
    for (const e of entries) {
      if (!admitted.has(e.index)) {
        blocks.set(e.index, {
          stage: 'diversity',
          detail: `指纹「${this.guard.fingerprint(e.verdict.candidate.skill)}」副本超配额（Echo 副本）`,
        });
        continue;
      }
      if (incumbent === undefined) {
        incumbent = e.verdict.score;
        continue;
      }
      const delta = incumbent - e.verdict.score;
      const decision = this.acceptance.decide(incumbent, e.verdict.score);
      if (decision.accepted) {
        incumbent = e.verdict.score;
        continue;
      }
      blocks.set(e.index, {
        stage: 'annealing',
        detail:
          `Δ=${delta.toFixed(3)} 未通过退火接受（T=${decision.temperature.toFixed(4)}，` +
          `接受概率 ${decision.probability.toFixed(3)}）`,
      });
    }
    return blocks;
  }

  /**
   * 回写裁决：被剔除的晋升裁决改写为未晋升并附闸位与依据。
   * @param verdicts 原裁决流
   * @param entries 降序扫描条目（提供原序下标）
   * @param blocks 剔除判定表
   * @returns 重写后的裁决流
   */
  private rewrite(
    verdicts: readonly PromotionVerdict[],
    entries: readonly AdmissionEntry[],
    blocks: ReadonlyMap<number, AdmissionBlock>,
  ): PromotionVerdict[] {
    const indexOf = new Map<PromotionVerdict, number>();
    for (const e of entries) indexOf.set(e.verdict, e.index);
    return verdicts.map((v) => {
      const index = indexOf.get(v);
      const block = index === undefined ? undefined : blocks.get(index);
      if (block === undefined) return v;
      const gate = block.stage === 'diversity' ? '多样性闸' : '退火接受';
      return { ...v, promoted: false, reason: `${v.reason}；${gate}否决晋升：${block.detail}` };
    });
  }

  /**
   * 剔除明细（按降序扫描顺序，确定性）。
   * @param entries 降序扫描条目
   * @param blocks 剔除判定表
   * @returns 剔除记录列表
   */
  private collectRejections(
    entries: readonly AdmissionEntry[],
    blocks: ReadonlyMap<number, AdmissionBlock>,
  ): AdmissionRejection[] {
    const out: AdmissionRejection[] = [];
    for (const e of entries) {
      const block = blocks.get(e.index);
      if (block === undefined) continue;
      out.push({ candidate: e.verdict.candidate, stage: block.stage, detail: block.detail });
    }
    return out;
  }
}
