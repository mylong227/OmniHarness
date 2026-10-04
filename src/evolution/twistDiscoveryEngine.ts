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
import type {
  Candidate,
  DiscoveryEngine,
  EvolutionContext,
  OperatorPort,
} from '../ports/runtime/evolution.js';
import { ArrayAt } from '../util/arrayAt.js';

/** TwistDiscoveryEngine 选项。 */
export interface TwistDiscoveryOptions {
  /**
   * 候选技能池（待组合的基础技能）。
   * （GEE Kernel v1 改造）支持**技能源提供者**：传函数则每轮 `nextCandidates()` 实读
   * （修「构造时快照导致运行中注册的新技能不进池」）；传数组则行为与旧快照语义逐位等价。
   */
  readonly skills: readonly Skill[] | (() => readonly Skill[]);
  /** 组合算子（通常注入 skillRegistry.composeByTwist，即燧-1）。允许第三个选项参数。 */
  readonly compose: (a: Skill, b: Skill, opts?: MoireOptions) => Skill;
  /** 硬预算：最多生成多少候选（防无限探索 / 防算力逃逸）。 */
  readonly maxCandidates: number;
  /** 组合算子用能力场边长（默认 64，须与基准一致）。 */
  readonly fieldSize?: number | undefined;
}

/** 基于燧-1 莫尔组合的发现引擎（**同时**实现 `OperatorPort`：Wave B 的算子契约，零休眠代码）。 */
export class TwistDiscoveryEngine implements DiscoveryEngine, OperatorPort {
  /** 技能源提供者（每轮实读；数组源退化为常量提供者）。 */
  private readonly skillsProvider: () => readonly Skill[];
  private readonly compose: (a: Skill, b: Skill, opts?: MoireOptions) => Skill;
  private readonly maxCandidates: number;
  private readonly fieldSize?: number | undefined;
  /** 已消费配对键（`a|b`，名字序）：技能源跨轮变化时避免重复生成同一配对。 */
  private readonly consumedPairs = new Set<string>();
  private generated = 0;

  public constructor(opts: TwistDiscoveryOptions) {
    const source = opts.skills;
    // 注意：窄化结果先落 const 再进闭包——TS 不保留「属性访问」窄化到闭包内（const 变量才保留）。
    this.skillsProvider = typeof source === 'function' ? source : (): readonly Skill[] => source;
    this.compose = opts.compose;
    this.maxCandidates = Math.max(0, opts.maxCandidates);
    this.fieldSize = opts.fieldSize;
  }

  /** 当前预算消耗：generated=已生成候选数，maxCandidates=构造时给定的硬上限。 */
  public budgetUsed(): { readonly generated: number; readonly maxCandidates: number } {
    return { generated: this.generated, maxCandidates: this.maxCandidates };
  }

  /**
   * 生成下一批候选：**每轮实读技能源**，沿无序配对（i<j，配对键去重跨轮）逐个推进，
   * 每对经燧-1 组合算子产出组合技能，直到触及 maxCandidates 硬预算或配对用尽；
   * 副作用为登记配对键并累计 generated（绝不超出预算）。
   * @returns 新生成的候选列表；空数组 = 预算耗尽或配对空间已用尽
   */
  public nextCandidates(): Candidate[] {
    const skills = this.skillsProvider();
    const out: Candidate[] = [];
    for (let i = 0; i < skills.length && this.generated < this.maxCandidates; i++) {
      const a = ArrayAt.at(skills, i);
      for (let j = i + 1; j < skills.length && this.generated < this.maxCandidates; j++) {
        const b = ArrayAt.at(skills, j);
        const pairKey = `${a.name}|${b.name}`;
        if (this.consumedPairs.has(pairKey)) continue;
        this.consumedPairs.add(pairKey);
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
    }
    return out;
  }

  /**
   * 算子端口实现（Wave B · `OperatorPort`）：把「按上下文产出候选」接到既有有界发现上。
   *
   * 语义**逐位沿用** `nextCandidates()`（同一份配对去重、同一份硬预算），只多两件事：
   * - 上下文预算已耗尽（`generated ≥ maxCandidates`）⇒ 直接返回空批（不试探、不绕过）；
   * - `bucketKey` 只被记录进候选来源（`twist:<桶>:a+b`），使下游分桶口径能看见工况——
   *   缺省不带桶时来源与既有 `twist:a+b` **逐字相同**（零行为变更）。
   * @param ctx 调度上下文（工况桶键 + 预算）
   * @returns 候选列表（空数组 = 预算耗尽或配对用尽）
   */
  public propose(ctx: EvolutionContext): readonly Candidate[] {
    if (ctx.budget.generated >= ctx.budget.maxCandidates) return [];
    const produced = this.nextCandidates();
    if (ctx.bucketKey === undefined) return produced;
    return produced.map((candidate) => ({
      ...candidate,
      source: candidate.source.replace('twist:', `twist:${ctx.bucketKey}:`),
    }));
  }
}
