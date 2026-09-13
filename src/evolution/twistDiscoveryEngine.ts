/**
 * 发现引擎（沙箱有界探索，I-P1-4 进化闭环的"发现"段）。
 *
 * 用燧-1 莫尔组合算子（composeByTwist）在技能池上生成候选组合能力，
 * 受 discoveryBudget（maxCandidates）硬上限约束——绝不在预算外自改、绝不暴露裸能力。
 * 每一次 nextCandidates() 吐出下一批未生成的配对组合；预算耗尽返回空数组。
 *
 * 这是 13_方案代码对账 判定的"决定性短板"的第一半：此前 OmniHarness 完全没有
 * "把实验产出变成候选能力"的机制；这里用已落地的燧-1 算子把它钉死，且有硬预算兜底。
 *
 * @maturity L1 — 失败模式挖掘在；是否真产出被门禁采纳的改进未量化
 * @maturityEvidence tests/unit/discoveryEngine.test.ts
 */
import type { Skill, MoireOptions } from '../skill/skill.js';
import type { Candidate, DiscoveryEngine } from '../ports/runtime/evolution.js';

/** TwistDiscoveryEngine 选项。 */
export interface TwistDiscoveryOptions {
  /** 候选技能池（待组合的基础技能）。 */
  readonly skills: readonly Skill[];
  /** 组合算子（通常注入 skillRegistry.composeByTwist，即燧-1）。允许第三个选项参数。 */
  readonly compose: (a: Skill, b: Skill, opts?: MoireOptions) => Skill;
  /** 硬预算：最多生成多少候选（防无限探索 / 防算力逃逸）。 */
  readonly maxCandidates: number;
  /** 组合算子用能力场边长（默认 64，须与基准一致）。 */
  readonly fieldSize?: number | undefined;
}

/** 基于燧-1 莫尔组合的发现引擎。 */
export class TwistDiscoveryEngine implements DiscoveryEngine {
  private readonly skills: readonly Skill[];
  private readonly compose: (a: Skill, b: Skill, opts?: MoireOptions) => Skill;
  private readonly maxCandidates: number;
  private readonly fieldSize?: number | undefined;
  private readonly pairs: ReadonlyArray<readonly [number, number]>;
  private cursor = 0;
  private generated = 0;

  public constructor(opts: TwistDiscoveryOptions) {
    this.skills = opts.skills;
    this.compose = opts.compose;
    this.maxCandidates = Math.max(0, opts.maxCandidates);
    this.fieldSize = opts.fieldSize;
    // 所有无序不同配对（i<j），作为探索空间。
    const pairs: Array<readonly [number, number]> = [];
    for (let i = 0; i < this.skills.length; i++) {
      for (let j = i + 1; j < this.skills.length; j++) {
        pairs.push([i, j]);
      }
    }
    this.pairs = pairs;
  }

  /** 当前预算消耗：generated=已生成候选数，maxCandidates=构造时给定的硬上限。 */
  public budgetUsed(): { readonly generated: number; readonly maxCandidates: number } {
    return { generated: this.generated, maxCandidates: this.maxCandidates };
  }

  /**
   * 生成下一批候选：沿构造时预计算的技能无序配对（i<j）逐个游标推进，
   * 每对经燧-1 组合算子产出组合技能，直到触及 maxCandidates 硬预算或配对用尽；
   * 副作用为推进游标并累计 generated（绝不超出预算）。
   * @returns 新生成的候选列表；空数组 = 预算耗尽或配对空间已用尽
   */
  public nextCandidates(): Candidate[] {
    const out: Candidate[] = [];
    while (this.cursor < this.pairs.length && this.generated < this.maxCandidates) {
      const [i, j] = this.pairs[this.cursor++]!;
      const a = this.skills[i]!;
      const b = this.skills[j]!;
      const composed = this.compose(
        a,
        b,
        this.fieldSize !== undefined ? { fieldSize: this.fieldSize } : undefined,
      );
      this.generated++;
      out.push({
        skill: composed,
        source: `twist:${a.name}+${b.name}`,
        meta: composed.moire as Readonly<Record<string, unknown>> | undefined,
      });
    }
    return out;
  }
}
