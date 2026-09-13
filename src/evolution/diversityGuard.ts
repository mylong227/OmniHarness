/**
 * 多样性保留（T5.2 · 抗 Echo Trap）。
 *
 * 解决的问题：同 corpus 连续进化时，选择压力让候选收敛成**近重复**（Echo Trap）：
 * 适应度数字还在涨，种群实际只剩一个「回声」，泛化能力已塌。守卫把「多样性不塌缩」
 * 变成机械判据：以技能的**规范指纹**（规范化 instructions + 标签集）计量重复度，
 * 同指纹超过配额的候选在准入阶段被拒（fail-closed 到保留最高分的首个副本）。
 *
 * 判定确定性：指纹稳定、去重按输入顺序保留首份、同分不掷硬币——同输入恒同结果。
 *
 * @maturity L1 — 指纹与配额是显式规则；「N 轮适应度改善且多样性不塌缩」由测试断言
 * @maturityEvidence tests/unit/diversityGuard.test.ts
 */
import type { Skill } from '../skill/skill.js';

/** 多样性守卫选项。 */
export interface DiversityGuardOptions {
  /** 同指纹最大副本数（默认 2：允许一主一备，第三份起拒）。 */
  readonly maxDuplicates?: number;
  /** 塌缩告警阈值：准入后去重率（distinct / admitted）低于此值即告警。默认 0.5（恰为配额 2 的构造下界——告警只在调用方传入更紧阈值时有意义，如 0.8）。 */
  readonly minDistinctRatio?: number;
}

/** 准入结果。 */
export interface DiversityVerdict<T> {
  /** 准入的候选（按输入顺序，同指纹保留首份直到配额用尽）。 */
  readonly admitted: readonly T[];
  /** 被拒的候选（Echo 副本超配额）。 */
  readonly rejected: readonly T[];
  /** 准入后种群的去重率。 */
  readonly distinctRatio: number;
  /** 是否触发塌缩告警（distinctRatio < minDistinctRatio；默认下限=构造下界，须收紧阈值才可触发）。 */
  readonly collapsed: boolean;
}

/**
 * 技能规范指纹：规范化 instructions（压缩空白、小写）+ 排序后的标签集。
 * 指纹相同 ⇒ 内容近重复（Echo），与名称无关（改名不算新意）。
 * @param skill 技能
 * @returns 规范指纹串
 */
export function skillFingerprint(skill: Skill): string {
  const body = skill.instructions.replace(/\s+/g, ' ').trim().toLowerCase();
  const tags = (skill.tags ?? [])
    .map((t) => t.toLowerCase())
    .sort()
    .join(',');
  return `${body}#${tags}`;
}

/**
 * 多样性守卫：对候选种群做 Echo 副本配额准入。
 */
export class DiversityGuard {
  /** 同指纹最大副本数。 */
  private readonly maxDuplicates: number;
  /** 塌缩告警阈值（去重率下限）。 */
  private readonly minDistinctRatio: number;

  /**
   * @param opts 副本配额与塌缩阈值
   */
  public constructor(opts: DiversityGuardOptions = {}) {
    this.maxDuplicates = Math.max(1, Math.floor(opts.maxDuplicates ?? 2));
    this.minDistinctRatio = Math.min(1, Math.max(0, opts.minDistinctRatio ?? 0.5));
  }

  /**
   * 准入判定：按输入顺序扫描，同指纹副本数超过配额即拒。
   * @param candidates 候选种群（期望已按适应度降序——保首份即保最优）
   * @returns 准入/拒绝明细 + 去重率与塌缩告警
   */
  public admit(candidates: readonly Skill[]): DiversityVerdict<Skill> {
    const counts = new Map<string, number>();
    const admitted: Skill[] = [];
    const rejected: Skill[] = [];
    for (const c of candidates) {
      const fp = skillFingerprint(c);
      const seen = counts.get(fp) ?? 0;
      if (seen < this.maxDuplicates) {
        admitted.push(c);
        counts.set(fp, seen + 1);
      } else {
        rejected.push(c);
      }
    }
    const distinct = counts.size;
    const distinctRatio = admitted.length === 0 ? 1 : distinct / admitted.length;
    return {
      admitted,
      rejected,
      distinctRatio,
      collapsed: admitted.length > 0 && distinctRatio < this.minDistinctRatio,
    };
  }
}
